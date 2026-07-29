// SPEC-032：远程节点 registry（反向模型）。
// 持久化已接入节点、维护各 RemoteRuntimeHost 并挂入联邦；拥有并编排主控网关（NodeGatewayServer）。
// 节点通过网关反向拨回 → 网关认证后回调 adopt → 对应 RemoteRuntimeHost 接管 socket。

import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  RUNTIME_PROTOCOL_VERSION,
  type CreateEnrollmentResult,
  type ManagedDeviceAuthorization,
  type ManagedDeviceAuthorizationStatus,
  type ManagedDeviceIdentity,
  type NodeEnrollment,
  type NodeGatewayStatus,
  type NodePlatform,
  type NodeReleaseReadiness,
  type RemoteNode,
  type RemoteNodeStatus,
  type RuntimeHost,
} from '@shared/types'
import type { FederatedRuntimeHost } from './federated-runtime-host'
import { RemoteRuntimeHost } from './remote-runtime-host'
import {
  NodeGatewayServer,
  lanAddress,
  type GatewayHooks,
  type ManagedGatewayCredential,
  type NodeGatewayOptions
} from './node-gateway-server'
import type { DaemonRegister } from './daemon-protocol'
import { checkNodeReleaseReadiness } from './node-release-readiness'
import type { DeviceAuthorizationRegistry } from './device-authorization'
import {
  AuthorizedRuntimeHost,
  ManagedAuthorizationRequestTracker,
  type ManagedSessionOwnershipRegistry
} from './authorized-runtime-host'
import { attachRuntimeRpcServer } from './runtime-rpc-endpoint'
import type { ManagedDevicePairingService, ManagedPairingEndpoint } from './managed-device-pairing'

export interface RemoteNodeStore {
  get(): RemoteNode[]
  set(nodes: RemoteNode[]): void
}

/** 网关 TLS/版本物料（由 index.ts 提供：主控自签证书 + 发行版本）。 */
export interface GatewayMaterial {
  cert: string
  key: string
  fingerprint: string
  version: string
  /** 构建时内嵌的源码 revision，用于防止同 SemVer 制品漂移。 */
  sourceRevision: string
  repo: string
  httpPort?: number
  wssPort?: number
  advertiseHost?: string
}

function gatewayErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : ''
  if (code === 'EADDRINUSE') {
    return '远程托管端口已被占用（EADDRINUSE）。请退出其他 Agent OS 实例或占用 7430/7431 的程序后重试。'
  }
  return error instanceof Error ? error.message : String(error)
}

export class RemoteNodeRegistry {
  private readonly hosts = new Map<string, RemoteRuntimeHost>()
  private gateway: NodeGatewayServer | null = null
  private gatewayError?: string
  private readonly managedRequests = new ManagedAuthorizationRequestTracker()
  private pairing: ManagedDevicePairingService | null = null
  /** GUI 开关、发现自动启用、网卡切换与退出可能并发到达；网关生命周期必须严格串行。 */
  private gatewayLifecycle: Promise<void> = Promise.resolve()

  constructor(
    private readonly federation: FederatedRuntimeHost,
    private readonly store: RemoteNodeStore,
    private readonly onStatus?: (status: RemoteNodeStatus) => void,
    private material?: GatewayMaterial,
    private gatewayEnabled = false,
    private readonly deviceAuthorizations?: DeviceAuthorizationRegistry,
    private readonly managedOwnerships?: ManagedSessionOwnershipRegistry,
    private readonly managedRuntime?: RuntimeHost
  ) {}

  /** 启动：为已持久化节点建好（离线的）RemoteRuntimeHost；若已开启远程托管则起网关。 */
  async init(): Promise<void> {
    for (const node of this.store.get()) this.spinUp(node)
    if (this.gatewayEnabled && this.material) {
      try {
        await this.startGateway()
      } catch (error) {
        this.gatewayError = gatewayErrorMessage(error)
      }
    }
  }

  private hooks(): GatewayHooks {
    return {
      lookupNodeByToken: (token) => this.store.get().find((n) => n.token === token)?.id ?? null,
      isNodeEnabled: (id) => this.store.get().find((n) => n.id === id)?.enabled !== false,
      isNodeConnected: (id) => this.hosts.get(id)?.status().connection === 'connected',
      registerNode: (enrollment, register) => this.registerNode(enrollment, register),
      adopt: (nodeId, socket, register) => this.adopt(nodeId, socket, register),
      rollbackNode: (nodeId) => this.remove(nodeId),
      ...(this.deviceAuthorizations && this.managedOwnerships && this.managedRuntime
        ? { adoptManaged: (socket: WebSocket, credential: ManagedGatewayCredential) => this.adoptManaged(socket, credential) }
        : {}),
      adoptPairing: (socket: WebSocket, remoteAddress: string) => {
        if (this.pairing) this.pairing.accept(socket, remoteAddress)
        else socket.close(4410, 'Pairing service unavailable')
      }
    }
  }

  setPairingService(pairing: ManagedDevicePairingService): void {
    this.pairing = pairing
  }

  pairingEndpoint(): ManagedPairingEndpoint | null {
    if (!this.gateway || !this.material) return null
    return {
      host: lanAddress(this.material.advertiseHost),
      port: this.material.wssPort ?? 7431,
      certificateFingerprint: this.material.fingerprint
    }
  }

  private async startGateway(): Promise<void> {
    if (this.gateway || !this.material) return
    const m = this.material
    const opts: NodeGatewayOptions = {
      cert: m.cert,
      key: m.key,
      fingerprint: m.fingerprint,
      version: m.version,
      repo: m.repo,
      httpPort: m.httpPort,
      wssPort: m.wssPort,
      advertiseHost: m.advertiseHost
    }
    const gateway = new NodeGatewayServer(opts, this.hooks())
    await gateway.start()
    this.gateway = gateway
    this.gatewayError = undefined
  }

  private async stopGateway(): Promise<void> {
    await this.gateway?.stop()
    this.gateway = null
  }

  private serializeGatewayLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.gatewayLifecycle.then(operation, operation)
    this.gatewayLifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  gatewayStatus(): NodeGatewayStatus {
    if (this.gateway) return this.gateway.status()
    return {
      enabled: false,
      host: this.material ? '' : '',
      port: this.material?.httpPort ?? 7430,
      fingerprint: this.material?.fingerprint ?? '',
      version: this.material?.version ?? '',
      error: this.gatewayError
    }
  }

  async setGatewayEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.serializeGatewayLifecycle(async () => {
      if (!this.material) return { ok: false, error: '网关物料未就绪' }
      try {
        if (enabled) await this.startGateway()
        else await this.stopGateway()
        this.gatewayEnabled = enabled
        this.gatewayError = undefined
        return { ok: true }
      } catch (error) {
        const message = gatewayErrorMessage(error)
        this.gatewayError = message
        return { ok: false, error: message }
      }
    })
  }

  async setAdvertiseHost(host: string): Promise<{ ok: boolean; error?: string }> {
    return this.serializeGatewayLifecycle(async () => {
      if (!this.material) return { ok: false, error: '网关物料未就绪' }
      const previous = this.material.advertiseHost
      this.material = { ...this.material, advertiseHost: host }
      if (!this.gateway) return { ok: true }
      try {
        await this.stopGateway()
        await this.startGateway()
        return { ok: true }
      } catch (error) {
        this.material = { ...this.material, advertiseHost: previous }
        await this.startGateway().catch(() => undefined)
        return { ok: false, error: gatewayErrorMessage(error) }
      }
    })
  }

  createEnrollment(label?: string): CreateEnrollmentResult
  createEnrollment(label: string | undefined, platform: NodePlatform): Promise<CreateEnrollmentResult>
  createEnrollment(label?: string, platform?: NodePlatform): CreateEnrollmentResult | Promise<CreateEnrollmentResult> {
    if (!this.gateway) throw new Error('请先开启「远程托管」')
    if (!platform) return this.gateway.createEnrollment(label)
    return this.createCheckedEnrollment(label, platform)
  }

  private async createCheckedEnrollment(label: string | undefined, platform: NodePlatform): Promise<CreateEnrollmentResult> {
    if (!this.gateway) throw new Error('请先开启「远程托管」')
    const readiness = await this.releaseReadiness()
    const target = readiness.platforms[platform]
    if (!target.ready || !target.sha256) {
      throw new Error(readiness.error || `v${readiness.version} 的 ${platform} 制品未就绪：${target.missing.join(', ')}`)
    }
    return this.gateway.createEnrollment(label, platform, target.sha256)
  }

  async releaseReadiness(): Promise<NodeReleaseReadiness> {
    if (!this.material) throw new Error('网关发行物料未就绪')
    return checkNodeReleaseReadiness(
      this.material.repo,
      this.material.version,
      this.material.sourceRevision
    )
  }

  list(): RemoteNode[] {
    // 不外泄 token 给渲染端。
    return this.store.get().map((n) => ({ ...n, token: '', enabled: n.enabled !== false }))
  }

  statuses(): RemoteNodeStatus[] {
    return [...this.hosts.values()].map((h) => h.status())
  }

  managedDeviceIdentity(): ManagedDeviceIdentity {
    if (!this.deviceAuthorizations) throw new Error('GUI 设备身份服务未就绪')
    return this.deviceAuthorizations.identity()
  }

  managedDeviceAuthorizations(): ManagedDeviceAuthorization[] {
    if (!this.deviceAuthorizations) throw new Error('GUI 方向性授权服务未就绪')
    return this.deviceAuthorizations.list()
  }

  async setManagedDeviceAuthorizationStatus(
    id: string,
    status: ManagedDeviceAuthorizationStatus
  ): Promise<ManagedDeviceAuthorization> {
    if (!this.deviceAuthorizations) throw new Error('GUI 方向性授权服务未就绪')
    const authorization = this.deviceAuthorizations.setStatus(id, status)
    if (status === 'active') {
      this.managedRequests.allow(id)
      return authorization
    }
    this.managedRequests.block(id)
    this.gateway?.disconnectManagedAuthorization(id)
    if (status === 'revoked' && this.managedOwnerships) {
      const runtime = this.managedRuntime ?? this.federation
      // 第一次中断已经存在/已经启动的工作；drain 后再扫一次捕获延迟 create/track 的资源。
      await this.managedOwnerships.terminate(id, runtime)
      await this.managedRequests.drain(id)
      await this.managedOwnerships.terminate(id, runtime)
    }
    return authorization
  }

  private async adoptManaged(socket: WebSocket, credential: ManagedGatewayCredential): Promise<void> {
    if (!this.deviceAuthorizations || !this.managedOwnerships || !this.managedRuntime || !this.material) {
      throw new Error('GUI 受托管 Runtime 未就绪')
    }
    const context = {
      authorizationId: credential.authorizationId,
      controllerDeviceId: credential.controllerDeviceId,
      credential: credential.credential
    }
    const authenticated = this.deviceAuthorizations.authenticate(context)
    if (!authenticated.allowed) throw new Error(`远程授权拒绝：${authenticated.reason}`)
    const runtime = new AuthorizedRuntimeHost(
      this.managedRuntime,
      this.deviceAuthorizations,
      this.managedOwnerships,
      context
    )
    attachRuntimeRpcServer(socket, {
      runtime,
      hostVersion: this.material.version,
      runtimeBuildId: `gui-managed:${authenticated.authorization.managedDeviceId}`,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      beforeRequest: () => {
        const current = this.deviceAuthorizations!.authenticate(context)
        if (!current.allowed) throw new Error(`远程授权拒绝：${current.reason}`)
        return this.managedRequests.begin(credential.authorizationId)
      },
      terminalProbe: async () => { throw new Error('受托管 GUI 不开放远程 PTY 探针') }
    })
    this.deviceAuthorizations.markConnected(credential.authorizationId)
  }

  private registerNode(enrollment: NodeEnrollment, register: DaemonRegister): string {
    const node: RemoteNode = {
      id: randomUUID(),
      label: register.label?.trim() || enrollment.label,
      host: '',
      port: 0,
      token: enrollment.nodeToken,
      fingerprint: '',
      enabled: true,
      platform: register.platform as NodePlatform | undefined,
      hostVersion: register.hostVersion,
      protocolVersion: register.protocolVersion,
      addedAt: new Date().toISOString()
    }
    this.store.set([...this.store.get(), node])
    this.spinUp(node)
    return node.id
  }

  private async adopt(nodeId: string, socket: WebSocket, register: DaemonRegister): Promise<void> {
    // 同步注册上报的 platform/version 到持久化记录。
    this.mutateNode(nodeId, (n) => ({
      ...n,
      platform: (register.platform as NodePlatform | undefined) ?? n.platform,
      hostVersion: register.hostVersion ?? n.hostVersion,
      protocolVersion: register.protocolVersion,
      lastConnectedAt: new Date().toISOString()
    }))
    const host = this.hosts.get(nodeId)
    if (!host) {
      socket.close()
      throw new Error('节点 Host 初始化失败')
    }
    await host.adoptConnection(socket)
    const status = host.status()
    if (status.connection !== 'connected') {
      throw new Error(status.error || '节点 Runtime 初始化失败')
    }
  }

  async setNodeEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const node = this.mutateNode(id, (n) => ({ ...n, enabled }))
    if (!node) return { ok: false, error: '节点不存在' }
    this.hosts.get(id)?.applyNode(node)
    return { ok: true }
  }

  async setNodeLabel(id: string, label: string): Promise<{ ok: boolean; error?: string }> {
    const node = this.mutateNode(id, (n) => ({ ...n, label: label.trim() || n.label }))
    if (!node) return { ok: false, error: '节点不存在' }
    this.hosts.get(id)?.applyNode(node)
    return { ok: true }
  }

  async setAgentEnabled(
    nodeId: string,
    agentId: string,
    enabled: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    const node = this.mutateAgentOverride(nodeId, agentId, (o) => ({ ...o, enabled }))
    if (!node) return { ok: false, error: '节点不存在' }
    this.hosts.get(nodeId)?.applyNode(node)
    return { ok: true }
  }

  async setAgentAlias(
    nodeId: string,
    agentId: string,
    alias: string
  ): Promise<{ ok: boolean; error?: string }> {
    const node = this.mutateAgentOverride(nodeId, agentId, (o) => ({
      ...o,
      alias: alias.trim() || undefined
    }))
    if (!node) return { ok: false, error: '节点不存在' }
    this.hosts.get(nodeId)?.applyNode(node)
    return { ok: true }
  }

  async remove(id: string): Promise<void> {
    const host = this.hosts.get(id)
    if (host) {
      await host.close()
      this.federation.removeHost(id)
      this.hosts.delete(id)
    }
    this.store.set(this.store.get().filter((n) => n.id !== id))
  }

  private spinUp(node: RemoteNode): void {
    const host = new RemoteRuntimeHost(node, (status) => this.onStatus?.(status))
    this.hosts.set(node.id, host)
    this.federation.addHost(node.id, host)
  }

  private mutateNode(id: string, fn: (n: RemoteNode) => RemoteNode): RemoteNode | null {
    let updated: RemoteNode | null = null
    const next = this.store.get().map((n) => {
      if (n.id !== id) return n
      updated = fn(n)
      return updated
    })
    if (updated) this.store.set(next)
    return updated
  }

  private mutateAgentOverride(
    nodeId: string,
    agentId: string,
    fn: (o: { enabled: boolean; alias?: string }) => { enabled: boolean; alias?: string }
  ): RemoteNode | null {
    return this.mutateNode(nodeId, (n) => {
      const overrides = { ...(n.agentOverrides ?? {}) }
      overrides[agentId] = fn(overrides[agentId] ?? { enabled: true })
      return { ...n, agentOverrides: overrides }
    })
  }

  async close(): Promise<void> {
    await this.serializeGatewayLifecycle(() => this.stopGateway())
    for (const host of this.hosts.values()) await host.close().catch(() => undefined)
    this.hosts.clear()
  }
}
