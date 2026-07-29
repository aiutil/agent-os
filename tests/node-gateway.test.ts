// SPEC-032 Step C：主控网关端到端。
// enroll 生成 token + 脚本 → 节点出站拨回网关 → 网关认证并回调 registry 自动建节点 →
// RemoteRuntimeHost 接管驱动；上报 platform/agents；禁用即断开。

import { EventEmitter } from 'node:events'
import { get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_PROTOCOL_VERSION,
  type HostEvent,
  type RemoteNode,
  type RuntimeHost
} from '../src/shared/types'
import { RemoteNodeRegistry, type GatewayMaterial } from '../src/main/domains/runtime/remote-registry'
import type { FederatedRuntimeHost } from '../src/main/domains/runtime/federated-runtime-host'
import { startNodeGatewayClient } from '../src/main/domains/runtime/node-gateway-client'
import { generateNodeTls } from '../src/main/domains/runtime/node-tls'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  // 子资源（WSS client）先于父资源（gateway server）关闭，避免重连与下一测试抢端口。
  for (const c of cleanups.splice(0).reverse()) await c()
})

const HTTP_PORT = 17630
const WSS_PORT = 17631

class NodeFakeRuntime extends EventEmitter {
  constructor(
    private readonly runtimesReady?: Promise<void>,
    private readonly runtimesError?: Error
  ) {
    super()
  }
  async hostStatus() {
    return { mode: 'daemon', connection: 'connected', sessionCount: 0, pid: 1 }
  }
  async listRuntimes() {
    await this.runtimesReady
    if (this.runtimesError) throw this.runtimesError
    return [
      { toolId: 'claude', displayName: 'Claude Code', channel: 'pty', canResume: true, capabilities: {}, health: 'ready', version: '1.2.3' },
      { toolId: 'codex', displayName: 'Codex', channel: 'pty', canResume: false, capabilities: {}, health: 'ready' }
    ]
  }
  async listSessions() {
    return []
  }
  subscribe(listener: (e: HostEvent) => void): () => void {
    this.on('ev', listener)
    return () => this.off('ev', listener)
  }
}

function fakeFederation(): FederatedRuntimeHost {
  return { addHost() {}, removeHost() {} } as unknown as FederatedRuntimeHost
}

function fetchText(
  url: string,
  headers?: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, { headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', (error) => reject(new Error(`${url}: ${error.message}`)))
  })
}

function material(httpPort = HTTP_PORT, wssPort = WSS_PORT): GatewayMaterial {
  const tls = generateNodeTls('agent-os-gateway')
  return {
    cert: tls.cert,
    key: tls.key,
    fingerprint: tls.fingerprint,
    version: '0.2.5',
    sourceRevision: 'a'.repeat(40),
    repo: 'aiutil/agent-os',
    httpPort,
    wssPort
  }
}

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function listenBlocker(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => resolve(server))
  })
}

function closeBlocker(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('SPEC-032 主控网关 e2e', () => {
  it('启动端口被占用时保留应用可用性，并可在释放后重试', async () => {
    const blocker = await listenBlocker(HTTP_PORT)
    cleanups.push(() => closeBlocker(blocker))
    const registry = new RemoteNodeRegistry(
      fakeFederation(),
      { get: () => [], set: () => undefined },
      undefined,
      material(),
      true
    )
    cleanups.push(() => registry.close())

    await registry.init()
    expect(registry.gatewayStatus()).toMatchObject({ enabled: false })
    expect(registry.gatewayStatus().error).toContain('EADDRINUSE')
    expect(registry.gatewayStatus().error).toContain('退出其他 Agent OS 实例')

    await closeBlocker(blocker)
    await expect(registry.setGatewayEnabled(true)).resolves.toEqual({ ok: true })
    expect(registry.gatewayStatus().enabled).toBe(true)
  })

  it('WSS 端口冲突时释放已监听的 HTTP 端口，解除冲突后可原地重试', async () => {
    const wssBlocker = await listenBlocker(WSS_PORT)
    cleanups.push(() => closeBlocker(wssBlocker))
    const registry = new RemoteNodeRegistry(
      fakeFederation(),
      { get: () => [], set: () => undefined },
      undefined,
      material(),
      true
    )
    cleanups.push(() => registry.close())

    await registry.init()
    expect(registry.gatewayStatus()).toMatchObject({ enabled: false })
    expect(registry.gatewayStatus().error).toContain('EADDRINUSE')

    // start() 已先监听 HTTP；若 WSS 失败清理不完整，这里会再次 EADDRINUSE。
    const httpProbe = await listenBlocker(HTTP_PORT)
    await closeBlocker(httpProbe)

    await closeBlocker(wssBlocker)
    await expect(registry.setGatewayEnabled(true)).resolves.toEqual({ ok: true })
    expect(registry.gatewayStatus().enabled).toBe(true)
  })

  it('并发启停严格按调用顺序收口，不留下幽灵监听或虚假失败', async () => {
    const registry = new RemoteNodeRegistry(
      fakeFederation(),
      { get: () => [], set: () => undefined },
      undefined,
      material(),
      false
    )
    cleanups.push(() => registry.close())
    await registry.init()

    const [firstEnable, secondEnable] = await Promise.all([
      registry.setGatewayEnabled(true),
      registry.setGatewayEnabled(true)
    ])
    expect(firstEnable).toEqual({ ok: true })
    expect(secondEnable).toEqual({ ok: true })
    expect(registry.gatewayStatus().enabled).toBe(true)

    await registry.setGatewayEnabled(false)
    const [enable, disable] = await Promise.all([
      registry.setGatewayEnabled(true),
      registry.setGatewayEnabled(false)
    ])
    expect(enable).toEqual({ ok: true })
    expect(disable).toEqual({ ok: true })
    expect(registry.gatewayStatus().enabled).toBe(false)

    const httpProbe = await listenBlocker(HTTP_PORT)
    const wssProbe = await listenBlocker(WSS_PORT)
    await closeBlocker(wssProbe)
    await closeBlocker(httpProbe)
  })

  it('enroll → 节点反向拨入 → 自动建节点 → 驱动 + 禁用', async () => {
    const nodes: RemoteNode[] = []
    const mat = material()
    const registry = new RemoteNodeRegistry(
      fakeFederation(),
      { get: () => nodes, set: (n) => (nodes.length = 0, nodes.push(...n)) },
      undefined,
      mat,
      true
    )
    cleanups.push(() => registry.close())
    await registry.init()

    // 1) 生成 enroll，HTTP 脚本只含短期换票，不包含长期 node token。
    const enroll = registry.createEnrollment('书房台式机')
    expect(enroll.commands.unix).toContain('/enroll/')
    expect(enroll.commands.powershell).toContain('.ps1')

    const script = await fetchText(`http://127.0.0.1:${HTTP_PORT}/enroll/${enroll.enrollId}`)
    expect(script.status).toBe(200)
    expect(script.body).toContain('TMP_TARBALL=')
    expect(script.body).toContain('--retry 5')
    expect(script.body).toContain('-o "$TMP_TARBALL"')
    const enrollmentToken = /ENROLL_TOKEN="([0-9a-f]+)"/.exec(script.body)?.[1]
    expect(enrollmentToken).toBeTruthy()
    expect(script.body).not.toContain('AGENT_OS_NODE_TOKEN=')

    const statusUrl = `http://127.0.0.1:${HTTP_PORT}/enroll/${enroll.enrollId}/status`
    const unauthorized = await fetchText(statusUrl)
    expect(unauthorized.status).toBe(401)
    expect(JSON.parse(unauthorized.body)).toEqual({ status: 'unauthorized' })
    const pending = await fetchText(statusUrl, { authorization: `Bearer ${enrollmentToken}` })
    expect(pending.status).toBe(202)
    expect(JSON.parse(pending.body)).toEqual({ status: 'pending' })

    // 2) 节点出站拨回网关（pin 主控指纹），在 WSS 内领取长期 token 后确认。
    let releaseRuntimes!: () => void
    const runtimesReady = new Promise<void>((resolve) => { releaseRuntimes = resolve })
    const runtime = new NodeFakeRuntime(runtimesReady)
    let persistedNodeToken = ''
    let clientState = ''
    let adopted: { nodeId: string; hostVersion: string; protocolVersion: number } | undefined
    let releaseAdoptedPersistence!: () => void
    const adoptedPersistenceReady = new Promise<void>((resolve) => { releaseAdoptedPersistence = resolve })
    const client = startNodeGatewayClient({
      url: `wss://127.0.0.1:${WSS_PORT}/agent`,
      enrollmentToken: enrollmentToken!,
      onEnrollmentAccepted: (token) => { persistedNodeToken = token },
      hostFingerprint: mat.fingerprint,
      rpc: {
        runtime: runtime as unknown as RuntimeHost,
        hostVersion: '0.2.5',
        runtimeBuildId: 'b',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      register: {
        label: '书房台式机',
        platform: 'win-x64',
        hostVersion: '0.2.5',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      onAdopted: async (acknowledgement) => {
        adopted = acknowledgement
        await adoptedPersistenceReady
      },
      onStateChange: (state) => { clientState = state }
    })
    cleanups.push(() => client.close())

    // 3) register 已持久化、但 hello/RPC/agent 刷新未完成时安装器仍只能看到 pending。
    await waitFor(() => nodes.length === 1)
    expect(clientState).toBe('connecting')
    expect(adopted).toBeUndefined()
    try {
      const adopting = await fetchText(statusUrl, { authorization: `Bearer ${enrollmentToken}` })
      expect(adopting.status).toBe(202)
      expect(JSON.parse(adopting.body)).toEqual({ status: 'pending' })
    } finally {
      releaseRuntimes()
    }

    // 4) Runtime 已接管但节点尚未完成本地 adopted 持久化时，安装器仍不能看到 registered。
    await waitFor(() => registry.statuses().some((s) => s.connection === 'connected'))
    await waitFor(() => adopted !== undefined)
    const notPersisted = await fetchText(statusUrl, { authorization: `Bearer ${enrollmentToken}` })
    expect(notPersisted.status).toBe(202)
    expect(JSON.parse(notPersisted.body)).toEqual({ status: 'pending' })
    expect(clientState).toBe('connecting')
    releaseAdoptedPersistence()

    // 5) 节点本地持久化完成并回执后，主控才消费 enrollment 并报告成功。
    await waitFor(() => clientState === 'connected')
    const st = registry.statuses()[0]
    expect(st.platform).toBe('win-x64')
    expect(st.label).toBe('书房台式机')
    expect(st.agents?.map((a) => a.id).sort()).toEqual(['claude', 'codex'])
    expect(persistedNodeToken).toMatch(/^[a-f0-9]{64}$/)
    expect(nodes[0].token).toBe(persistedNodeToken)
    expect(persistedNodeToken).not.toBe(enrollmentToken)
    expect(adopted).toMatchObject({
      nodeId: nodes[0].id,
      hostVersion: '0.2.5',
      protocolVersion: RUNTIME_PROTOCOL_VERSION
    })

    const registered = await fetchText(statusUrl, { authorization: `Bearer ${enrollmentToken}` })
    expect(registered.status).toBe(200)
    expect(JSON.parse(registered.body)).toMatchObject({
      status: 'registered',
      nodeId: nodes[0].id,
      completedAt: expect.any(String)
    })

    // 历史完成记录不能掩盖当前断线；安装器只在轮询瞬间仍在线时成功。
    client.close()
    await waitFor(() => registry.statuses()[0].connection === 'disconnected')
    const disconnectedStatus = await fetchText(statusUrl, {
      authorization: `Bearer ${enrollmentToken}`
    })
    expect(disconnectedStatus.status).toBe(202)
    expect(JSON.parse(disconnectedStatus.body)).toEqual({ status: 'pending' })

    // enroll 已消费 → 再取 410。
    const reuse = await fetchText(`http://127.0.0.1:${HTTP_PORT}/enroll/${enroll.enrollId}`)
    expect(reuse.status).toBe(410)

    // list 不外泄 token。
    expect(registry.list()[0].token).toBe('')

    // 6) 禁用节点 → 断开。
    const nodeId = registry.list()[0].id
    await registry.setNodeEnabled(nodeId, false)
    await waitFor(() => registry.statuses()[0].connection === 'disabled')
    expect(registry.statuses()[0].enabled).toBe(false)
  })

  it('节点未能持久化长期 token 时不消费 enrollment、不登记半成品节点', async () => {
    const nodes: RemoteNode[] = []
    const httpPort = HTTP_PORT + 10
    const wssPort = WSS_PORT + 10
    const mat = material(httpPort, wssPort)
    const registry = new RemoteNodeRegistry(
      fakeFederation(),
      { get: () => nodes, set: (next) => (nodes.length = 0, nodes.push(...next)) },
      undefined,
      mat,
      true
    )
    cleanups.push(() => registry.close())
    await registry.init()

    const enroll = registry.createEnrollment('持久化失败节点')
    const script = await fetchText(`http://127.0.0.1:${httpPort}/enroll/${enroll.enrollId}`)
    const enrollmentToken = /ENROLL_TOKEN="([0-9a-f]+)"/.exec(script.body)?.[1]
    expect(enrollmentToken).toBeTruthy()
    let persistenceError = ''
    const client = startNodeGatewayClient({
      url: `wss://127.0.0.1:${wssPort}/agent`,
      enrollmentToken,
      onEnrollmentAccepted: () => { throw new Error('磁盘只读') },
      hostFingerprint: mat.fingerprint,
      minBackoffMs: 5_000,
      rpc: {
        runtime: new NodeFakeRuntime() as unknown as RuntimeHost,
        hostVersion: '0.2.5',
        runtimeBuildId: 'b',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      register: { label: '持久化失败节点', platform: 'linux-x64', protocolVersion: RUNTIME_PROTOCOL_VERSION },
      onStateChange: (state, error) => {
        if (state === 'disconnected' && error) persistenceError = error.message
      }
    })
    cleanups.push(() => client.close())

    await waitFor(() => persistenceError.includes('磁盘只读'))
    expect(nodes).toHaveLength(0)
    const pending = await fetchText(
      `http://127.0.0.1:${httpPort}/enroll/${enroll.enrollId}/status`,
      { authorization: `Bearer ${enrollmentToken}` }
    )
    expect(pending.status).toBe(202)
    expect(JSON.parse(pending.body)).toEqual({ status: 'pending' })
    const retry = await fetchText(`http://127.0.0.1:${httpPort}/enroll/${enroll.enrollId}`)
    expect(retry.status).toBe(200)
  })

  it.each([
    {
      caseName: '协议校验',
      portOffset: 20,
      protocolVersion: RUNTIME_PROTOCOL_VERSION + 1,
      runtime: () => new NodeFakeRuntime(),
      terminalProbe: undefined
    },
    {
      caseName: 'agent 发现 RPC',
      portOffset: 30,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtime: () => new NodeFakeRuntime(undefined, new Error('agent discovery failed')),
      terminalProbe: undefined
    },
    {
      caseName: '远程 PTY 探针',
      portOffset: 40,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtime: () => new NodeFakeRuntime(),
      terminalProbe: async () => { throw new Error('node-pty remote probe failed') }
    }
  ])('节点 $caseName 失败时不返回 registered，并清理半成品节点', async ({
    caseName,
    portOffset,
    protocolVersion,
    runtime,
    terminalProbe
  }) => {
    const nodes: RemoteNode[] = []
    const httpPort = HTTP_PORT + portOffset
    const wssPort = WSS_PORT + portOffset
    const mat = material(httpPort, wssPort)
    const registry = new RemoteNodeRegistry(
      fakeFederation(),
      { get: () => nodes, set: (next) => (nodes.length = 0, nodes.push(...next)) },
      undefined,
      mat,
      true
    )
    cleanups.push(() => registry.close())
    await registry.init()

    const enroll = registry.createEnrollment(`${caseName}失败节点`)
    const script = await fetchText(`http://127.0.0.1:${httpPort}/enroll/${enroll.enrollId}`)
    const enrollmentToken = /ENROLL_TOKEN="([0-9a-f]+)"/.exec(script.body)?.[1]
    expect(enrollmentToken).toBeTruthy()
    let disconnected = false
    let connected = false
    const client = startNodeGatewayClient({
      url: `wss://127.0.0.1:${wssPort}/agent`,
      enrollmentToken,
      onEnrollmentAccepted: () => undefined,
      hostFingerprint: mat.fingerprint,
      minBackoffMs: 5_000,
      rpc: {
        runtime: runtime() as unknown as RuntimeHost,
        hostVersion: '0.2.5',
        runtimeBuildId: `bad-${caseName}`,
        protocolVersion,
        terminalProbe
      },
      register: {
        label: `${caseName}失败节点`,
        platform: 'linux-x64',
        protocolVersion
      },
      onStateChange: (state) => {
        if (state === 'connected') connected = true
        if (state === 'disconnected') disconnected = true
      }
    })
    cleanups.push(() => client.close())

    await waitFor(() => disconnected)
    expect(connected).toBe(false)
    await waitFor(() => nodes.length === 0)
    expect(registry.statuses()).toHaveLength(0)
    const pending = await fetchText(
      `http://127.0.0.1:${httpPort}/enroll/${enroll.enrollId}/status`,
      { authorization: `Bearer ${enrollmentToken}` }
    )
    expect(pending.status).toBe(202)
    expect(JSON.parse(pending.body)).toEqual({ status: 'pending' })
  })

  it('节点本地 adopted 状态持久化失败时不返回 registered，并回滚半成品节点', async () => {
    const nodes: RemoteNode[] = []
    const httpPort = HTTP_PORT + 50
    const wssPort = WSS_PORT + 50
    const mat = material(httpPort, wssPort)
    const registry = new RemoteNodeRegistry(
      fakeFederation(),
      { get: () => nodes, set: (next) => (nodes.length = 0, nodes.push(...next)) },
      undefined,
      mat,
      true
    )
    cleanups.push(() => registry.close())
    await registry.init()

    const enroll = registry.createEnrollment('持久化失败节点')
    const script = await fetchText(`http://127.0.0.1:${httpPort}/enroll/${enroll.enrollId}`)
    const enrollmentToken = /ENROLL_TOKEN="([0-9a-f]+)"/.exec(script.body)?.[1]
    expect(enrollmentToken).toBeTruthy()
    let disconnected = false
    let connected = false
    const client = startNodeGatewayClient({
      url: `wss://127.0.0.1:${wssPort}/agent`,
      enrollmentToken,
      onEnrollmentAccepted: () => undefined,
      hostFingerprint: mat.fingerprint,
      minBackoffMs: 5_000,
      rpc: {
        runtime: new NodeFakeRuntime() as unknown as RuntimeHost,
        hostVersion: '0.2.5',
        runtimeBuildId: 'adopted-persistence-failure',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      register: {
        label: '持久化失败节点',
        platform: 'linux-x64',
        hostVersion: '0.2.5',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      onAdopted: () => { throw new Error('node-status atomic write failed') },
      onStateChange: (state) => {
        if (state === 'connected') connected = true
        if (state === 'disconnected') disconnected = true
      }
    })
    cleanups.push(() => client.close())

    await waitFor(() => disconnected)
    expect(connected).toBe(false)
    await waitFor(() => nodes.length === 0)
    const pending = await fetchText(
      `http://127.0.0.1:${httpPort}/enroll/${enroll.enrollId}/status`,
      { authorization: `Bearer ${enrollmentToken}` }
    )
    expect(pending.status).toBe(202)
    expect(JSON.parse(pending.body)).toEqual({ status: 'pending' })
  })

  it('adopted 回执前断线后以已落盘长期 token 重连，仍完成原 enrollment 而不绕过确认', async () => {
    const nodes: RemoteNode[] = []
    const httpPort = HTTP_PORT + 60
    const wssPort = WSS_PORT + 60
    const mat = material(httpPort, wssPort)
    const registry = new RemoteNodeRegistry(
      fakeFederation(),
      { get: () => nodes, set: (next) => (nodes.length = 0, nodes.push(...next)) },
      undefined,
      mat,
      true
    )
    cleanups.push(() => registry.close())
    await registry.init()

    const enroll = registry.createEnrollment('回执断线恢复节点')
    const script = await fetchText(`http://127.0.0.1:${httpPort}/enroll/${enroll.enrollId}`)
    const enrollmentToken = /ENROLL_TOKEN="([0-9a-f]+)"/.exec(script.body)?.[1]
    expect(enrollmentToken).toBeTruthy()
    let persistedNodeToken = ''
    let adoptionAttempts = 0
    let connected = false
    const client = startNodeGatewayClient({
      url: `wss://127.0.0.1:${wssPort}/agent`,
      enrollmentToken,
      onEnrollmentAccepted: (token) => { persistedNodeToken = token },
      hostFingerprint: mat.fingerprint,
      minBackoffMs: 20,
      maxBackoffMs: 50,
      rpc: {
        runtime: new NodeFakeRuntime() as unknown as RuntimeHost,
        hostVersion: '0.2.5',
        runtimeBuildId: 'adopted-confirm-reconnect',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      register: {
        label: '回执断线恢复节点',
        platform: 'linux-x64',
        hostVersion: '0.2.5',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      onAdopted: () => {
        adoptionAttempts += 1
        if (adoptionAttempts === 1) throw new Error('模拟回执前断线')
      },
      onStateChange: (state) => { if (state === 'connected') connected = true }
    })
    cleanups.push(() => client.close())

    await waitFor(() => connected)
    expect(adoptionAttempts).toBeGreaterThanOrEqual(2)
    expect(persistedNodeToken).toMatch(/^[a-f0-9]{64}$/)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].token).toBe(persistedNodeToken)
    const registered = await fetchText(
      `http://127.0.0.1:${httpPort}/enroll/${enroll.enrollId}/status`,
      { authorization: `Bearer ${enrollmentToken}` }
    )
    expect(registered.status).toBe(200)
    expect(JSON.parse(registered.body)).toMatchObject({
      status: 'registered',
      nodeId: nodes[0].id
    })
  })

  it('已登记节点重连时刷新持久化的主程序与协议版本', async () => {
    const token = 'existing-node-token'
    const mat = material()
    const nodes: RemoteNode[] = [
      {
        id: 'existing-node',
        label: 'opencode-docker-node',
        host: '',
        port: 0,
        token,
        fingerprint: '',
        enabled: true,
        platform: 'linux-arm64',
        hostVersion: '0.2.5',
        protocolVersion: RUNTIME_PROTOCOL_VERSION - 1,
        addedAt: '2026-07-01T00:00:00.000Z'
      }
    ]
    const registry = new RemoteNodeRegistry(
      fakeFederation(),
      { get: () => nodes, set: (next) => (nodes.length = 0, nodes.push(...next)) },
      undefined,
      mat,
      true
    )
    cleanups.push(() => registry.close())
    await registry.init()

    const runtime = new NodeFakeRuntime()
    let adoptedNodeId = ''
    let clientConnected = false
    const client = startNodeGatewayClient({
      url: `wss://127.0.0.1:${WSS_PORT}/agent`,
      token,
      hostFingerprint: mat.fingerprint,
      rpc: {
        runtime: runtime as unknown as RuntimeHost,
        hostVersion: '0.2.6',
        runtimeBuildId: 'current-build',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      register: {
        label: 'opencode-docker-node',
        platform: 'linux-arm64',
        hostVersion: '0.2.6',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      onAdopted: (acknowledgement) => { adoptedNodeId = acknowledgement.nodeId },
      onStateChange: (state) => { if (state === 'connected') clientConnected = true }
    })
    cleanups.push(() => client.close())

    await waitFor(() => registry.statuses()[0]?.connection === 'connected')
    await waitFor(() => clientConnected)
    expect(adoptedNodeId).toBe('existing-node')
    expect(nodes[0]).toMatchObject({
      hostVersion: '0.2.6',
      protocolVersion: RUNTIME_PROTOCOL_VERSION
    })
  })
})
