import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type {
  HostEvent,
  CreateSessionInput,
  ManagedDeviceAuthorizationRecord,
  ManagedDeviceIdentityRecord,
  ManagedSessionOwnership,
  RuntimeHost
} from '../src/shared/types'
import {
  DeviceAuthorizationRegistry,
  type DeviceAuthorizationStore
} from '../src/main/domains/runtime/device-authorization'
import { ManagedSessionOwnershipRegistry } from '../src/main/domains/runtime/authorized-runtime-host'
import { RemoteNodeRegistry, type GatewayMaterial } from '../src/main/domains/runtime/remote-registry'
import type { FederatedRuntimeHost } from '../src/main/domains/runtime/federated-runtime-host'
import { generateNodeTls } from '../src/main/domains/runtime/node-tls'
import { GATEWAY_MAX_PAYLOAD_BYTES } from '../src/main/domains/runtime/node-gateway-server'

const HTTP_PORT = 17930
const WSS_PORT = 17931
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class MemoryAuthorizationStore implements DeviceAuthorizationStore {
  identity: ManagedDeviceIdentityRecord | null = null
  authorizations: ManagedDeviceAuthorizationRecord[] = []
  getIdentity = (): ManagedDeviceIdentityRecord | null => this.identity
  setIdentity = (identity: ManagedDeviceIdentityRecord): void => { this.identity = identity }
  getAuthorizations = (): ManagedDeviceAuthorizationRecord[] => this.authorizations
  setAuthorizations = (authorizations: ManagedDeviceAuthorizationRecord[]): void => {
    this.authorizations = authorizations
  }
}

class ManagedFakeRuntime extends EventEmitter {
  kill = vi.fn(async () => true)
  interruptTurn = vi.fn(async () => true)
  private createGate?: Promise<void>
  private releaseCreate?: () => void
  private createStarted?: () => void

  deferNextCreate(): { started: Promise<void>; release: () => void } {
    let started!: () => void
    let release!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    this.createGate = new Promise<void>((resolve) => { release = resolve })
    this.createStarted = started
    this.releaseCreate = release
    return { started: startedPromise, release: () => this.releaseCreate?.() }
  }

  async createSession(input: CreateSessionInput) {
    this.createStarted?.()
    await this.createGate
    this.createStarted = undefined
    this.createGate = undefined
    this.releaseCreate = undefined
    const now = new Date().toISOString()
    return {
      session: {
        id: 'deferred-session',
        name: input.name,
        toolId: input.toolId,
        workspacePath: input.workspacePath,
        terminalSessionId: 'deferred-terminal',
        nativeSessionId: null,
        surface: input.surface,
        permissionPreset: 'safe' as const,
        memoryUse: false,
        memoryGenerate: false,
        favorite: false,
        pinned: false,
        createdAt: now,
        updatedAt: now
      },
      terminal: {
        sessionId: 'deferred-terminal',
        toolId: input.toolId,
        cwd: input.workspacePath,
        command: input.toolId,
        backend: 'pty' as const,
        createdAt: now
      }
    }
  }
  async hostStatus() {
    return { mode: 'in-process' as const, connection: 'connected' as const, sessionCount: 99 }
  }
  async listRuntimes() {
    return [{
      toolId: 'claude',
      displayName: 'Claude Code',
      executablePath: '/Users/managed/.local/bin/claude',
      channel: 'pty' as const,
      canResume: true,
      capabilities: {},
      health: 'ready' as const
    }]
  }
  subscribe(listener: (event: HostEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }
}

function gatewayMaterial(): GatewayMaterial {
  const tls = generateNodeTls('agent-os-managed-gateway')
  return {
    cert: tls.cert,
    key: tls.key,
    fingerprint: tls.fingerprint,
    version: '0.3.0',
    sourceRevision: 'b'.repeat(40),
    repo: 'aiutil/agent-os',
    httpPort: HTTP_PORT,
    wssPort: WSS_PORT,
    advertiseHost: '127.0.0.1'
  }
}

function openSocket(path = '/managed'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${WSS_PORT}${path}`, { rejectUnauthorized: false })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw) => {
      try { resolve(JSON.parse(String(raw)) as Record<string, unknown>) } catch (error) { reject(error) }
    })
    socket.once('error', reject)
  })
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
}

async function authenticate(
  socket: WebSocket,
  credential: { authorizationId: string; controllerDeviceId: string; credential: string }
): Promise<Record<string, unknown>> {
  const response = nextJson(socket)
  socket.send(JSON.stringify({ type: 'managed-auth', ...credential }))
  return response
}

async function rpc(
  socket: WebSocket,
  id: string,
  method: string,
  params: unknown[] = []
): Promise<Record<string, unknown>> {
  const response = nextJson(socket)
  socket.send(JSON.stringify({ type: 'request', id, method, params }))
  return response
}

describe('SPEC-032 Step J2 GUI /managed WSS', () => {
  it('首帧认证后只暴露授权 Runtime，错误凭证、非法 RPC、重连和暂停均 fail closed', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'agentos-managed-wss-'))
    cleanups.push(() => rmSync(temp, { recursive: true, force: true }))
    const store = new MemoryAuthorizationStore()
    const authorizations = new DeviceAuthorizationRegistry(store, { displayName: '受托管 Mac' })
    const controller = new DeviceAuthorizationRegistry(new MemoryAuthorizationStore(), { displayName: '控制端 Mac' })
    const granted = authorizations.grant({
      controllerDeviceId: controller.identity().deviceId,
      controllerDisplayName: '控制端 Mac',
      controllerPublicKey: controller.identity().publicKey,
      capabilities: [
        'runtime:status', 'runtime:list-agents', 'directory:list',
        'session:create', 'session:read', 'session:write', 'session:terminate'
      ],
      allowedRoots: [temp]
    })
    const payloadController = new DeviceAuthorizationRegistry(
      new MemoryAuthorizationStore(),
      { displayName: '帧上限测试控制端' }
    )
    const payloadGrant = authorizations.grant({
      controllerDeviceId: payloadController.identity().deviceId,
      controllerDisplayName: '帧上限测试控制端',
      controllerPublicKey: payloadController.identity().publicKey,
      capabilities: ['runtime:status'],
      allowedRoots: []
    })
    let ownershipRecords: ManagedSessionOwnership[] = []
    const ownerships = new ManagedSessionOwnershipRegistry({
      get: () => ownershipRecords,
      set: (records) => { ownershipRecords = records }
    })
    const runtime = new ManagedFakeRuntime()
    const federation = { addHost() {}, removeHost() {} } as unknown as FederatedRuntimeHost
    const registry = new RemoteNodeRegistry(
      federation,
      { get: () => [], set: () => undefined },
      undefined,
      gatewayMaterial(),
      true,
      authorizations,
      ownerships,
      runtime as unknown as RuntimeHost
    )
    cleanups.push(() => registry.close())
    await registry.init()

    // URL 里出现任何查询参数都拒绝，避免长期凭证进入代理/访问日志。
    await expect(openSocket('/managed?credential=secret')).rejects.toThrow()

    const oversizedAuth = await openSocket()
    cleanups.push(() => oversizedAuth.close())
    const oversizedAuthClosed = closed(oversizedAuth)
    oversizedAuth.send('x'.repeat(GATEWAY_MAX_PAYLOAD_BYTES + 1))
    await expect(oversizedAuthClosed).resolves.toMatchObject({ code: 1009 })

    const auth = {
      authorizationId: granted.authorization.id,
      controllerDeviceId: controller.identity().deviceId,
      credential: granted.credential
    }
    const first = await openSocket()
    cleanups.push(() => first.close())
    await expect(authenticate(first, auth)).resolves.toMatchObject({
      type: 'managed-authenticated',
      authorizationId: granted.authorization.id
    })
    expect(authorizations.list()[0].lastConnectedAt).toEqual(expect.any(String))

    await expect(rpc(first, 'agents', 'listRuntimes')).resolves.toEqual({
      type: 'response',
      id: 'agents',
      result: [{
        toolId: 'claude',
        displayName: 'Claude Code',
        channel: 'pty',
        canResume: true,
        capabilities: {},
        health: 'ready'
      }]
    })
    await expect(rpc(first, 'invalid', 'constructor')).resolves.toMatchObject({
      type: 'response',
      id: 'invalid',
      error: '无效 Runtime RPC 请求'
    })
    await expect(rpc(first, 'probe', 'probeTerminal')).resolves.toMatchObject({
      type: 'response',
      id: 'probe',
      error: '受托管 GUI 不开放远程 PTY 探针'
    })

    const oversizedRpc = await openSocket()
    cleanups.push(() => oversizedRpc.close())
    await authenticate(oversizedRpc, {
      authorizationId: payloadGrant.authorization.id,
      controllerDeviceId: payloadController.identity().deviceId,
      credential: payloadGrant.credential
    })
    const oversizedRpcClosed = closed(oversizedRpc)
    oversizedRpc.send(JSON.stringify({
      type: 'request',
      id: 'oversized',
      method: 'sendTurn',
      params: ['session', 'x'.repeat(GATEWAY_MAX_PAYLOAD_BYTES)]
    }))
    await expect(oversizedRpcClosed).resolves.toMatchObject({ code: 1009 })

    // 冒用同一 authorizationId 的错误凭证只能关闭自身，不能踢掉合法连接。
    const attacker = await openSocket()
    cleanups.push(() => attacker.close())
    const attackerClosed = closed(attacker)
    attacker.send(JSON.stringify({ type: 'managed-auth', ...auth, credential: '0'.repeat(64) }))
    await expect(attackerClosed).resolves.toMatchObject({ code: 4401 })
    expect(first.readyState).toBe(WebSocket.OPEN)

    // 合法重连原子替换旧连接；随后暂停授权会定向断开当前连接。
    const firstClosed = closed(first)
    const second = await openSocket()
    cleanups.push(() => second.close())
    await expect(authenticate(second, auth)).resolves.toMatchObject({ type: 'managed-authenticated' })
    await expect(firstClosed).resolves.toMatchObject({ code: 4400 })
    const secondClosed = closed(second)
    await registry.setManagedDeviceAuthorizationStatus(granted.authorization.id, 'paused')
    await expect(secondClosed).resolves.toMatchObject({ code: 4403 })

    const paused = await openSocket()
    cleanups.push(() => paused.close())
    const pausedClosed = closed(paused)
    paused.send(JSON.stringify({ type: 'managed-auth', ...auth }))
    await expect(pausedClosed).resolves.toMatchObject({ code: 4401 })

    await registry.setManagedDeviceAuthorizationStatus(granted.authorization.id, 'active')
    const finalSocket = await openSocket()
    cleanups.push(() => finalSocket.close())
    await authenticate(finalSocket, auth)
    const deferred = runtime.deferNextCreate()
    finalSocket.send(JSON.stringify({
      type: 'request',
      id: 'deferred-create',
      method: 'createSession',
      params: [{ name: 'deferred', toolId: 'claude', workspacePath: temp, surface: 'terminal' }]
    }))
    await deferred.started
    let revokeSettled = false
    const finalClosed = closed(finalSocket)
    const revoke = registry.setManagedDeviceAuthorizationStatus(granted.authorization.id, 'revoked')
      .then(() => { revokeSettled = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(revokeSettled).toBe(false)
    deferred.release()
    await revoke
    await expect(finalClosed).resolves.toMatchObject({ code: 4403 })
    expect(runtime.kill).toHaveBeenCalledWith('deferred-terminal')
    expect(runtime.interruptTurn).toHaveBeenCalledWith('deferred-session')
    expect(ownershipRecords).toContainEqual(expect.objectContaining({
      authorizationId: granted.authorization.id,
      sessionId: 'deferred-session',
      terminalSessionId: 'deferred-terminal'
    }))
  })
})
