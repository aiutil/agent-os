// SPEC-032：远程节点在主控侧的受管句柄（反向模型）。
// 节点主动拨回主控网关；网关认证后把 socket 交给本类 adoptConnection 接管。
// 本类实现整个 RuntimeHost：在线时委托 DaemonRuntimeHost（驱动节点），离线时列表返回空、会话级方法报错。
// 不做主控侧重连——断开后等节点自己重连（网关会再次 adoptConnection）。

import type { WebSocket } from 'ws'
import {
  RUNTIME_PROTOCOL_VERSION,
  type ChatTurnState,
  type AgentTask,
  type CreateSessionInput,
  type CreateTaskInput,
  type HostEvent,
  type ListRuntimeDirectoriesInput,
  type ManagedChatMessage,
  type ManagedQueuedTurn,
  type ManagedChatTimelineItem,
  type NodeAgentInfo,
  type PermissionDecision,
  type RemoteNode,
  type RemoteNodeStatus,
  type RuntimeHello,
  type RuntimeDirectoryListing,
  type RuntimeHostStatus,
  type RuntimeInfo,
  type RuntimeSessionHandle,
  type TerminalRunState,
  type TaskRun,
  type ToolModelCatalog,
  type UpdateSessionPatch,
  type UpdateTaskPatch,
  type WorkbenchSession,
  type WorkbenchSessionView
} from '@shared/types'
import { filterUsableRuntimes } from '@shared/runtime-availability'
import { DaemonRuntimeHost } from './daemon-runtime-host'
import type { RuntimeEventListener, RuntimeHost } from './protocol'

export class RemoteRuntimeHost implements RuntimeHost {
  private daemon: DaemonRuntimeHost | null = null
  private daemonUnsub: (() => void) | null = null
  private readonly listeners = new Set<RuntimeEventListener>()
  private connection: RemoteNodeStatus['connection'] = 'disconnected'
  private lastError?: string
  private lastConnectedAt?: string
  /** 节点上报的原始 agent 列表（由 listRuntimes 推导），未叠加 override。 */
  private rawAgents: { id: string; name: string; version?: string }[] = []

  constructor(
    private node: RemoteNode,
    private readonly onStatusChange?: (status: RemoteNodeStatus) => void,
    private readonly options: { probeTerminal?: boolean } = {}
  ) {
    if (node.enabled === false) this.connection = 'disabled'
  }

  get id(): string {
    return this.node.id
  }

  /** 更新持久化节点引用（label/override/enabled 改动后）。 */
  applyNode(node: RemoteNode): void {
    const wasDisabled = this.node.enabled === false
    this.node = node
    if (node.enabled === false && !wasDisabled) {
      void this.disconnect('disabled')
    } else if (node.enabled !== false && this.connection === 'disabled') {
      this.connection = 'disconnected'
    }
    this.emitStatus()
  }

  private agents(): NodeAgentInfo[] {
    const overrides = this.node.agentOverrides ?? {}
    return this.rawAgents.map((a) => ({
      id: a.id,
      name: a.name,
      version: a.version,
      alias: overrides[a.id]?.alias,
      enabled: overrides[a.id]?.enabled !== false
    }))
  }

  status(): RemoteNodeStatus {
    return {
      id: this.node.id,
      label: this.node.label,
      host: this.node.host ?? '',
      port: this.node.port ?? 0,
      connection: this.connection,
      error: this.lastError,
      enabled: this.node.enabled !== false,
      platform: this.node.platform,
      hostVersion: this.node.hostVersion,
      agents: this.connection === 'connected' ? this.agents() : undefined,
      lastConnectedAt: this.lastConnectedAt
    }
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.status())
  }

  /** 网关把一条已认证的节点 socket 交给本类驱动。 */
  async adoptConnection(socket: WebSocket): Promise<void> {
    if (this.node.enabled === false) {
      socket.close()
      return
    }
    // 接管前丢弃旧连接（节点重连场景）。
    await this.dropDaemon()
    const daemon = DaemonRuntimeHost.adopt(socket, {
      onDisconnect: () => void this.disconnect('disconnected')
    })
    try {
      const hello = await daemon.hello()
      if (hello.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
        throw new Error(
          `协议版本不匹配：期望 ${RUNTIME_PROTOCOL_VERSION}，实际 ${hello.protocolVersion}`
        )
      }
      this.node.hostVersion = hello.hostVersion
      this.daemon = daemon
      this.daemonUnsub = daemon.subscribe((event) => {
        for (const listener of this.listeners) listener(event)
      })
      if (this.options.probeTerminal !== false) await daemon.probeTerminal()
      await this.refreshAgents()
      this.connection = 'connected'
      this.lastError = undefined
      this.lastConnectedAt = new Date().toISOString()
      this.emitStatus()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.connection = 'error'
      this.daemonUnsub?.()
      this.daemonUnsub = null
      if (this.daemon === daemon) this.daemon = null
      await daemon.close().catch(() => undefined)
      this.emitStatus()
    }
  }

  private async refreshAgents(): Promise<void> {
    const runtimes = filterUsableRuntimes(await this.daemon!.listRuntimes())
    this.rawAgents = runtimes.map((r) => ({
      id: r.toolId,
      name: r.displayName,
      version: r.version
    }))
  }

  private async dropDaemon(): Promise<void> {
    this.daemonUnsub?.()
    this.daemonUnsub = null
    const d = this.daemon
    this.daemon = null
    await d?.close().catch(() => undefined)
  }

  private async disconnect(state: 'disconnected' | 'disabled'): Promise<void> {
    await this.dropDaemon()
    this.rawAgents = []
    this.connection = state
    this.emitStatus()
  }

  async close(): Promise<void> {
    await this.dropDaemon()
  }

  private get live(): DaemonRuntimeHost {
    if (!this.daemon) throw new Error(`远程节点「${this.node.label}」未连接`)
    return this.daemon
  }

  hello(): Promise<RuntimeHello> {
    return this.live.hello()
  }
  hostStatus(): Promise<RuntimeHostStatus> {
    return this.live.hostStatus()
  }
  async listRuntimes(): Promise<RuntimeInfo[]> {
    if (!this.daemon) return []
    const runtimes = filterUsableRuntimes(await this.daemon.listRuntimes())
    const overrides = this.node.agentOverrides ?? {}
    // 过滤被主控禁用的 agent。
    return runtimes.filter((r) => overrides[r.toolId]?.enabled !== false)
  }
  async listModels(toolId: string): Promise<ToolModelCatalog> {
    if (!this.daemon) {
      return { models: [], source: 'unavailable', supportsCustomModel: false }
    }
    try {
      return await this.daemon.listModels(toolId)
    } catch {
      // 旧版节点不认识 listModels → 空列表（前端降级为「由 CLI 决定」）。
      return { models: [], source: 'unavailable', supportsCustomModel: false }
    }
  }
  async listDirectories(input?: ListRuntimeDirectoriesInput): Promise<RuntimeDirectoryListing> {
    if (!this.daemon) throw new Error(`远程节点「${this.node.label}」未连接`)
    try {
      return await this.daemon.listDirectories({ ...(input ?? {}), hostId: this.node.id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('is not a function') || message.includes('Cannot read')) {
        throw new Error('远程节点版本过旧，不支持目录浏览')
      }
      throw error
    }
  }
  async listSessions(): Promise<WorkbenchSession[]> {
    return this.daemon ? this.daemon.listSessions() : []
  }
  async listSessionViews(): Promise<WorkbenchSessionView[]> {
    return this.daemon ? this.daemon.listSessionViews() : []
  }
  async states(): Promise<TerminalRunState[]> {
    return this.daemon ? this.daemon.states() : []
  }
  createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    return this.live.createSession(input)
  }
  resumeSession(id: string): Promise<RuntimeSessionHandle> {
    return this.live.resumeSession(id)
  }
  openLinkedTerminal(id: string): Promise<RuntimeSessionHandle> {
    return this.live.openLinkedTerminal(id)
  }
  updateSession(id: string, patch: UpdateSessionPatch): Promise<WorkbenchSession | null> {
    return this.live.updateSession(id, patch)
  }
  removeSession(id: string): Promise<void> {
    return this.live.removeSession(id)
  }
  write(sessionId: string, data: string): Promise<boolean> {
    return this.live.write(sessionId, data)
  }
  resize(sessionId: string, cols: number, rows: number): Promise<boolean> {
    return this.live.resize(sessionId, cols, rows)
  }
  history(sessionId: string): Promise<string> {
    return this.live.history(sessionId)
  }
  state(sessionId: string): Promise<TerminalRunState | null> {
    return this.live.state(sessionId)
  }
  kill(sessionId: string): Promise<boolean> {
    return this.live.kill(sessionId)
  }
  sendTurn(sessionId: string, text: string, files?: string[], contextPack?: import('@shared/types').TurnContextPack): Promise<ChatTurnState> {
    return this.live.sendTurn(sessionId, text, files, contextPack)
  }
  steerTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    return this.live.steerTurn(sessionId, text, files)
  }
  queueTurn(sessionId: string, text: string, files?: string[], contextPack?: import('@shared/types').TurnContextPack): Promise<ManagedQueuedTurn> {
    return this.live.queueTurn(sessionId, text, files, contextPack)
  }
  listQueuedTurns(sessionId: string): Promise<ManagedQueuedTurn[]> {
    return this.live.listQueuedTurns(sessionId)
  }
  cancelQueuedTurn(sessionId: string, queuedTurnId: string): Promise<boolean> {
    return this.live.cancelQueuedTurn(sessionId, queuedTurnId)
  }
  interruptTurn(sessionId: string): Promise<boolean> {
    return this.live.interruptTurn(sessionId)
  }
  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<ChatTurnState> {
    return this.live.respondPermission(sessionId, requestId, decision)
  }
  chatState(sessionId: string): Promise<ChatTurnState> {
    return this.live.chatState(sessionId)
  }
  chatHistory(sessionId: string): Promise<ManagedChatMessage[]> {
    return this.live.chatHistory(sessionId)
  }
  chatTimeline(sessionId: string): Promise<ManagedChatTimelineItem[]> {
    return this.live.chatTimeline(sessionId)
  }
  async listTasks(): Promise<AgentTask[]> {
    return this.daemon ? this.daemon.listTasks() : []
  }
  async listTaskRuns(taskId: string): Promise<TaskRun[]> {
    return this.daemon ? this.daemon.listTaskRuns(taskId) : []
  }
  createTask(input: CreateTaskInput): Promise<AgentTask> {
    return this.live.createTask(input)
  }
  updateTask(id: string, patch: UpdateTaskPatch): Promise<AgentTask | null> {
    return this.live.updateTask(id, patch)
  }
  removeTask(id: string): Promise<void> {
    return this.live.removeTask(id)
  }
  runTaskNow(id: string): Promise<TaskRun> {
    return this.live.runTaskNow(id)
  }
  attach(sessionId: string): AsyncIterable<HostEvent> {
    return this.live.attach(sessionId)
  }
  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
