import { createServer } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type {
  CreateManagedDeviceConnectionInput,
  ManagedDeviceAuthorizationRecord,
  ManagedDeviceConnection,
  ManagedDeviceIdentityRecord,
  ManagedPairingSession,
  NearbyManagedDevice,
  NodeEnrollment
} from '../src/shared/types'
import { DeviceAuthorizationRegistry } from '../src/main/domains/runtime/device-authorization'
import {
  ManagedDevicePairingService,
  type ManagedPairingDiscoveryTransport
} from '../src/main/domains/runtime/managed-device-pairing'
import { NodeGatewayServer } from '../src/main/domains/runtime/node-gateway-server'
import { certFingerprint, generateNodeTls } from '../src/main/domains/runtime/node-tls'

class FakeDiscovery implements ManagedPairingDiscoveryTransport {
  advertised: NearbyManagedDevice | null = null
  private onUp?: (device: NearbyManagedDevice) => void

  start(onUp: (device: NearbyManagedDevice) => void): void {
    this.onUp = onUp
  }
  advertise(device: NearbyManagedDevice): void {
    this.advertised = device
  }
  stopAdvertising(): void {
    this.advertised = null
  }
  close(): void {
    this.advertised = null
  }
  discover(device: NearbyManagedDevice): void {
    this.onUp?.(device)
  }
}

function authorizationRegistry(name: string): DeviceAuthorizationRegistry {
  let identity: ManagedDeviceIdentityRecord | null = null
  let authorizations: ManagedDeviceAuthorizationRecord[] = []
  return new DeviceAuthorizationRegistry({
    getIdentity: () => identity,
    setIdentity: (value) => { identity = value },
    getAuthorizations: () => authorizations,
    setAuthorizations: (value) => { authorizations = value }
  }, { displayName: name, canonicalizePath: realpathSync.native })
}

class FakeControllers {
  readonly added: CreateManagedDeviceConnectionInput[] = []
  failAdd = false

  list(): ManagedDeviceConnection[] { return [] }
  add(input: CreateManagedDeviceConnectionInput): ManagedDeviceConnection {
    if (this.failAdd) throw new Error('simulated persistence failure')
    this.added.push(input)
    return {
      schemaVersion: 1,
      id: '11111111-1111-4111-8111-111111111111',
      ...input,
      enabled: true,
      connection: 'connecting',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  }
  async setEnabled(): Promise<ManagedDeviceConnection> { throw new Error('not used') }
  async remove(): Promise<void> {}
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitFor(
  read: () => ManagedPairingSession | undefined,
  state: ManagedPairingSession['state']
): Promise<ManagedPairingSession> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const value = read()
    if (value?.state === state) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for pairing state ${state}`)
}

async function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => socket.once('message', (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>)))
}

async function websocketCloseCode(url: string, payload?: string): Promise<number> {
  const socket = new WebSocket(url, { rejectUnauthorized: false })
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      if (payload !== undefined) socket.send(payload)
    })
    socket.once('close', (code) => resolve(code))
    socket.once('error', reject)
  })
}

async function startMaliciousPairingServer(
  port: number,
  tls: { cert: string; key: string },
  fingerprint: string,
  managed: ReturnType<DeviceAuthorizationRegistry['identity']>,
  mode: 'before-confirm' | 'instead-of-confirmed' | 'challenge-only',
  challengeOverrides: Record<string, unknown> = {}
): Promise<HttpsServer> {
  const server = createHttpsServer(tls)
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.once('message', (raw) => {
        const pairRequest = JSON.parse(String(raw)) as { controller: ReturnType<DeviceAuthorizationRegistry['identity']> }
        const sessionId = randomUUID()
        ws.send(JSON.stringify({
          type: 'pair-challenge',
          sessionId,
          managed,
          certificateFingerprint: fingerprint,
          shortCode: '123456',
          serverNonce: randomBytes(32).toString('hex'),
          ttlMs: 5 * 60_000,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...challengeOverrides
        }))
        if (mode === 'challenge-only') return
        const approveOutOfOrder = (): void => ws.send(JSON.stringify({
          type: 'pair-approved',
          sessionId,
          authorization: {
            schemaVersion: 1,
            id: randomUUID(),
            controllerDeviceId: pairRequest.controller.deviceId,
            managedDeviceId: managed.deviceId,
            capabilities: ['runtime:status'],
            allowedRoots: []
          },
          credential: 'a'.repeat(64),
          managedUrl: `wss://127.0.0.1:${port}/managed`,
          certificateFingerprint: fingerprint
        }))
        if (mode === 'before-confirm') setTimeout(approveOutOfOrder, 10)
        else ws.once('message', approveOutOfOrder)
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}

describe('managed GUI pairing', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map(async (cleanup) => cleanup()))
  })

  it('advertises only temporary minimum metadata and stops immediately when disabled', async () => {
    const discovery = new FakeDiscovery()
    const root = mkdtempSync(join(tmpdir(), 'agent-os-pairing-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const service = new ManagedDevicePairingService({
      authorizations: authorizationRegistry('Managed Mac'),
      controllers: new FakeControllers(),
      discovery,
      getEndpoint: () => ({
        host: '192.168.1.20',
        port: 7431,
        certificateFingerprint: 'AA:'.repeat(31) + 'AA'
      }),
      platform: 'darwin'
    })
    cleanups.push(() => service.close())
    service.init(true)

    expect(discovery.advertised).toMatchObject({
      displayName: 'Managed Mac',
      platform: 'darwin',
      host: '192.168.1.20',
      port: 7431,
      protocolVersion: 1
    })
    expect(discovery.advertised?.discoveryId).toMatch(/^[a-f0-9]{16}$/)
    expect(service.snapshot().manualEndpoint).toBe('192.168.1.20:7431')
    expect(JSON.stringify(discovery.advertised)).not.toContain(service.snapshot().identity.deviceId)
    expect(JSON.stringify(discovery.advertised)).not.toContain('publicKey')

    service.setDiscoverable(false)
    expect(discovery.advertised).toBeNull()
  })

  it('completes signed short-code approval and delivers a pinned one-way authorization once', async () => {
    const httpPort = await freePort()
    const wssPort = await freePort()
    const tls = generateNodeTls('pairing-test')
    const fingerprint = certFingerprint(tls.cert)
    const managedAuth = authorizationRegistry('Managed Mac')
    const controllerAuth = authorizationRegistry('Controller Mac')
    const managedControllers = new FakeControllers()
    const controllerControllers = new FakeControllers()
    const serverDiscovery = new FakeDiscovery()
    const clientDiscovery = new FakeDiscovery()
    const endpoint = { host: '127.0.0.1', port: wssPort, certificateFingerprint: fingerprint }
    const managed = new ManagedDevicePairingService({
      authorizations: managedAuth,
      controllers: managedControllers,
      discovery: serverDiscovery,
      getEndpoint: () => endpoint
    })
    const controller = new ManagedDevicePairingService({
      authorizations: controllerAuth,
      controllers: controllerControllers,
      discovery: clientDiscovery,
      getEndpoint: () => null
    })
    const pairing = managed
    const gateway = new NodeGatewayServer({
      host: '127.0.0.1', httpPort, wssPort,
      cert: tls.cert, key: tls.key, fingerprint,
      version: '0.3.0', repo: 'example/repo'
    }, {
      lookupNodeByToken: () => null,
      registerNode: (_enrollment: NodeEnrollment) => { throw new Error('not used') },
      adopt: async () => {},
      rollbackNode: async () => {},
      isNodeEnabled: () => false,
      isNodeConnected: () => false,
      adoptPairing: (socket, address) => pairing.accept(socket, address)
    })
    await gateway.start()
    managed.init(true)
    controller.init(false)
    cleanups.push(() => gateway.stop(), () => managed.close(), () => controller.close())

    await new Promise<void>((resolve, reject) => {
      const querySocket = new WebSocket(`wss://127.0.0.1:${wssPort}/pairing?credential=forbidden`, { rejectUnauthorized: false })
      querySocket.once('unexpected-response', (_request, response) => {
        try {
          expect(response.statusCode).toBe(400)
          response.resume()
          resolve()
        } catch (error) {
          reject(error)
        }
      })
      querySocket.once('open', () => reject(new Error('query-bearing pairing socket unexpectedly opened')))
      querySocket.once('error', () => undefined)
    })
    expect(await websocketCloseCode(
      `wss://127.0.0.1:${wssPort}/pairing`,
      'x'.repeat(64 * 1024 + 1)
    )).toBe(1009)

    const outgoing = await controller.requestManual(`127.0.0.1:${wssPort}`)
    const incoming = managed.snapshot().sessions.find((item) => item.role === 'managed')
    expect(incoming?.shortCode).toBe(outgoing.shortCode)
    expect(outgoing.certificateFingerprint).toBe(fingerprint)
    expect(outgoing.peerPublicKeyFingerprint).toBe(managedAuth.identity().publicKeyFingerprint)

    controller.confirm(outgoing.id)
    expect(() => controller.confirm(outgoing.id)).toThrow('当前配对状态不能确认短码')
    await waitFor(
      () => managed.snapshot().sessions.find((item) => item.id === outgoing.id),
      'awaiting_local_approval'
    )
    const allowedRoot = mkdtempSync(join(tmpdir(), 'agent-os-allowed-'))
    cleanups.push(() => rmSync(allowedRoot, { recursive: true, force: true }))
    managed.approve(outgoing.id, {
      capabilities: ['runtime:status', 'directory:list'],
      allowedRoots: [allowedRoot]
    })
    await waitFor(
      () => controller.snapshot().sessions.find((item) => item.id === outgoing.id),
      'active'
    )
    await waitFor(
      () => managed.snapshot().sessions.find((item) => item.id === outgoing.id),
      'active'
    )

    expect(controllerControllers.added).toHaveLength(1)
    expect(controllerControllers.added[0]).toMatchObject({
      controllerDeviceId: controllerAuth.identity().deviceId,
      managedDeviceId: managedAuth.identity().deviceId,
      managedDisplayName: 'Managed Mac',
      url: `wss://127.0.0.1:${wssPort}/managed`,
      certificateFingerprint: fingerprint,
      allowedRoots: [realpathSync.native(allowedRoot)]
    })
    expect(controllerControllers.added[0]?.credential).toMatch(/^[a-f0-9]{64}$/)
    expect(managedAuth.list()).toHaveLength(1)
    expect(managedAuth.list()[0]?.status).toBe('active')
    expect(JSON.stringify(controller.snapshot())).not.toContain(controllerControllers.added[0]?.credential)

    // 当前来源已使用 2 次（超限帧 + 正常配对）；再允许 3 次无效请求，第 6 次应立即限流。
    for (let index = 0; index < 3; index += 1) {
      expect(await websocketCloseCode(`wss://127.0.0.1:${wssPort}/pairing`, '{}')).toBe(4401)
    }
    expect(await websocketCloseCode(`wss://127.0.0.1:${wssPort}/pairing`)).toBe(4429)
  })

  it('revokes the new authorization if the controller cannot persist and acknowledge it', async () => {
    const httpPort = await freePort()
    const wssPort = await freePort()
    const tls = generateNodeTls('pairing-revoke-test')
    const fingerprint = certFingerprint(tls.cert)
    const managedAuth = authorizationRegistry('Managed')
    const controllerAuth = authorizationRegistry('Controller')
    const controllerControllers = new FakeControllers()
    controllerControllers.failAdd = true
    const endpoint = { host: '127.0.0.1', port: wssPort, certificateFingerprint: fingerprint }
    const managed = new ManagedDevicePairingService({
      authorizations: managedAuth,
      controllers: new FakeControllers(),
      discovery: new FakeDiscovery(),
      getEndpoint: () => endpoint
    })
    const controller = new ManagedDevicePairingService({
      authorizations: controllerAuth,
      controllers: controllerControllers,
      discovery: new FakeDiscovery(),
      getEndpoint: () => null
    })
    const gateway = new NodeGatewayServer({
      host: '127.0.0.1', httpPort, wssPort,
      cert: tls.cert, key: tls.key, fingerprint,
      version: '0.3.0', repo: 'example/repo'
    }, {
      lookupNodeByToken: () => null,
      registerNode: () => { throw new Error('not used') },
      adopt: async () => {},
      rollbackNode: async () => {},
      isNodeEnabled: () => false,
      isNodeConnected: () => false,
      adoptPairing: (socket, address) => managed.accept(socket, address)
    })
    await gateway.start()
    managed.init(true)
    controller.init(false)
    cleanups.push(() => gateway.stop(), () => managed.close(), () => controller.close())

    const session = await controller.requestManual(`127.0.0.1:${wssPort}`)
    controller.confirm(session.id)
    await waitFor(() => managed.snapshot().sessions.find((item) => item.id === session.id), 'awaiting_local_approval')
    managed.approve(session.id, { capabilities: ['runtime:status'], allowedRoots: [] })
    await waitFor(() => controller.snapshot().sessions.find((item) => item.id === session.id), 'failed')
    await waitFor(() => managedAuth.list()[0] && managed.snapshot().sessions.find((item) => item.id === session.id), 'failed')
    expect(managedAuth.list()[0]?.status).toBe('revoked')
  })

  it('keeps a delivered credential paused and revokes it on an independent ACK deadline', async () => {
    const httpPort = await freePort()
    const wssPort = await freePort()
    const tls = generateNodeTls('pairing-ack-timeout-test')
    const fingerprint = certFingerprint(tls.cert)
    const managedAuth = authorizationRegistry('Managed')
    const controllerAuth = authorizationRegistry('Controller')
    const endpoint = { host: '127.0.0.1', port: wssPort, certificateFingerprint: fingerprint }
    const managed = new ManagedDevicePairingService({
      authorizations: managedAuth,
      controllers: new FakeControllers(),
      discovery: new FakeDiscovery(),
      getEndpoint: () => endpoint,
      ackTimeoutMs: 50
    })
    const gateway = new NodeGatewayServer({
      host: '127.0.0.1', httpPort, wssPort,
      cert: tls.cert, key: tls.key, fingerprint,
      version: '0.3.0', repo: 'example/repo'
    }, {
      lookupNodeByToken: () => null,
      registerNode: () => { throw new Error('not used') },
      adopt: async () => {},
      rollbackNode: async () => {},
      isNodeEnabled: () => false,
      isNodeConnected: () => false,
      adoptPairing: (socket, address) => managed.accept(socket, address)
    })
    await gateway.start()
    managed.init(true)
    cleanups.push(() => gateway.stop(), () => managed.close())

    const socket = new WebSocket(`wss://127.0.0.1:${wssPort}/pairing`, { rejectUnauthorized: false })
    cleanups.push(() => socket.close())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const controller = controllerAuth.identity()
    const requestId = randomUUID()
    const clientNonce = randomBytes(32).toString('hex')
    const requestPayload = ['agentos-pair-request-v1', requestId, clientNonce, controller.deviceId, controller.publicKey].join('\n')
    socket.send(JSON.stringify({
      type: 'pair-request', requestId, clientNonce, controller,
      signature: controllerAuth.sign(requestPayload)
    }))
    const challenge = await nextJson(socket)
    const sessionId = String(challenge.sessionId)
    const confirmPayload = [
      'agentos-pair-confirm-v1', sessionId, requestId, clientNonce,
      String(challenge.serverNonce), String(challenge.shortCode)
    ].join('\n')
    socket.send(JSON.stringify({
      type: 'pair-confirm', sessionId,
      signature: controllerAuth.sign(confirmPayload)
    }))
    expect((await nextJson(socket)).type).toBe('pair-confirmed')
    await waitFor(() => managed.snapshot().sessions.find((item) => item.id === sessionId), 'awaiting_local_approval')
    managed.approve(sessionId, { capabilities: ['runtime:status'], allowedRoots: [] })
    const approved = await nextJson(socket)
    const authorization = approved.authorization as { id: string }
    const credential = String(approved.credential)

    expect(managedAuth.list()[0]?.status).toBe('paused')
    expect(managed.snapshot().inboundAuthorizations).toHaveLength(0)
    expect(() => managed.assertAuthorizationStatusChangeAllowed(authorization.id)).toThrow(
      '配对授权仍在等待控制端安全确认'
    )
    expect(managedAuth.authenticate({
      authorizationId: authorization.id,
      controllerDeviceId: controller.deviceId,
      credential
    }).allowed).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(managedAuth.list()[0]?.status).toBe('revoked')
    expect(managedAuth.authenticate({
      authorizationId: authorization.id,
      controllerDeviceId: controller.deviceId,
      credential
    }).allowed).toBe(false)
  })

  it.each(['before-confirm', 'instead-of-confirmed'] as const)(
    'rejects an out-of-order pair-approved message %s without persisting credentials',
    async (mode) => {
      const wssPort = await freePort()
      const tls = generateNodeTls(`malicious-pairing-${mode}`)
      const fingerprint = certFingerprint(tls.cert)
      const managedAuth = authorizationRegistry('Malicious peer')
      const controllerAuth = authorizationRegistry('Controller')
      const controllers = new FakeControllers()
      const server = await startMaliciousPairingServer(
        wssPort,
        tls,
        fingerprint,
        managedAuth.identity(),
        mode
      )
      const controller = new ManagedDevicePairingService({
        authorizations: controllerAuth,
        controllers,
        discovery: new FakeDiscovery(),
        getEndpoint: () => null
      })
      controller.init(false)
      cleanups.push(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
        () => controller.close()
      )

      const session = await controller.requestManual(`127.0.0.1:${wssPort}`)
      if (mode === 'instead-of-confirmed') controller.confirm(session.id)
      await waitFor(() => controller.snapshot().sessions.find((item) => item.id === session.id), 'failed')
      expect(controllers.added).toHaveLength(0)
      expect(controller.snapshot().outboundConnections).toHaveLength(0)
    }
  )

  it.each([
    ['far-future expiry', { expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString() }],
    ['invalid expiry', { expiresAt: 'not-a-date' }],
    ['wrong TLS fingerprint', { certificateFingerprint: 'BB:'.repeat(31) + 'BB' }]
  ] as const)('rejects a malicious challenge with %s', async (_label, challengeOverrides) => {
    const wssPort = await freePort()
    const tls = generateNodeTls('malicious-challenge')
    const fingerprint = certFingerprint(tls.cert)
    const managedAuth = authorizationRegistry('Malicious peer')
    const controllerAuth = authorizationRegistry('Controller')
    const controllers = new FakeControllers()
    const server = await startMaliciousPairingServer(
      wssPort,
      tls,
      fingerprint,
      managedAuth.identity(),
      'challenge-only',
      challengeOverrides
    )
    const controller = new ManagedDevicePairingService({
      authorizations: controllerAuth,
      controllers,
      discovery: new FakeDiscovery(),
      getEndpoint: () => null
    })
    controller.init(false)
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => controller.close()
    )

    await expect(controller.requestManual(`127.0.0.1:${wssPort}`)).rejects.toThrow(
      '受托管端配对挑战无效或 TLS 指纹不匹配'
    )
    expect(controller.snapshot().sessions).toHaveLength(0)
    expect(controllers.added).toHaveLength(0)
  })

  it.each([30_000, 60_000])(
    'accepts %dms managed clock skew but still expires on the controller local five-minute deadline',
    async (clockSkewMs) => {
    const wssPort = await freePort()
    const tls = generateNodeTls('pairing-expiry')
    const fingerprint = certFingerprint(tls.cert)
    const managedAuth = authorizationRegistry('Managed')
    const controllerAuth = authorizationRegistry('Controller')
    const controllers = new FakeControllers()
    let now = Date.now()
    const server = await startMaliciousPairingServer(
      wssPort,
      tls,
      fingerprint,
      managedAuth.identity(),
      'challenge-only',
      { expiresAt: new Date(now + 5 * 60_000 + clockSkewMs).toISOString() }
    )
    const controller = new ManagedDevicePairingService({
      authorizations: controllerAuth,
      controllers,
      discovery: new FakeDiscovery(),
      getEndpoint: () => null,
      now: () => new Date(now)
    })
    controller.init(false)
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => controller.close()
    )

    const session = await controller.requestManual(`127.0.0.1:${wssPort}`)
    expect(session.expiresAt).toBe(new Date(now + 5 * 60_000).toISOString())
    now += 5 * 60_000 + 1
    expect(() => controller.confirm(session.id)).toThrow('当前配对状态不能确认短码')
    expect(controller.snapshot().sessions.find((item) => item.id === session.id)?.state).toBe('expired')
    expect(controllers.added).toHaveLength(0)
    }
  )
})
