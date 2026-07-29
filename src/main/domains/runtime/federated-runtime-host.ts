// 联邦 RuntimeHost：把「本机 + N 个远程节点」聚合成一个 RuntimeHost。
// - 会话级方法按「sessionId/terminalId 归属的主机」路由；
// - 列表/聚合方法合并各主机结果，并给每条打 runtimeHostId；
// - 订阅合并所有主机事件，原样转发（sessionId 为 UUID，跨主机天然不冲突）。
// hello/hostStatus 走本机。

import type {
  ChatTurnState,
  AgentTask,
  CreateSessionInput,
  CreateTaskInput,
  HostEvent,
  ListRuntimeDirectoriesInput,
  ManagedChatMessage,
  ManagedQueuedTurn,
  ManagedChatTimelineItem,
  PermissionDecision,
  RuntimeHello,
  RuntimeDirectoryListing,
  RuntimeHostStatus,
  RuntimeInfo,
  RuntimeSessionHandle,
  TerminalRunState,
  TaskRun,
  ToolModelCatalog,
  UpdateSessionPatch,
  UpdateTaskPatch,
  WorkbenchSession,
  WorkbenchSessionView
} from '@shared/types'
import { sortSessionViews } from '../sessions/view'
import type { RuntimeEventListener, RuntimeHost } from './protocol'

export const LOCAL_HOST_ID = 'local'

export interface FederatedRuntimeAnalyticsHooks {
  sessionCreated?(input: CreateSessionInput, handle: RuntimeSessionHandle): void
  taskCreated?(input: CreateTaskInput, task: AgentTask): void
}

export class FederatedRuntimeHost implements RuntimeHost {
  private readonly hosts = new Map<string, RuntimeHost>()
  private readonly unsubs = new Map<string, () => void>()
  private readonly listeners = new Set<RuntimeEventListener>()
  /** sessionId / terminalId → 归属主机 id。 */
  private readonly routes = new Map<string, string>()
  private readonly taskRoutes = new Map<string, string>()

  constructor(
    local: RuntimeHost,
    private readonly localId: string = LOCAL_HOST_ID,
    private readonly analytics: FederatedRuntimeAnalyticsHooks = {}
  ) {
    this.addHost(localId, local)
  }

  /** 注册一个主机（本机或远程节点）。 */
  addHost(id: string, host: RuntimeHost): void {
    if (this.hosts.has(id)) this.removeHost(id)
    this.hosts.set(id, host)
    const off = host.subscribe((event) => {
      if ('sessionId' in event) this.routes.set(event.sessionId, id)
      if (event.kind === 'task-changed') {
        this.taskRoutes.set(event.event.task.id, id)
        const stamped: HostEvent = {
          ...event,
          event: { ...event.event, task: { ...event.event.task, runtimeHostId: id } }
        }
        for (const listener of this.listeners) listener(stamped)
        return
      }
      for (const listener of this.listeners) listener(event)
    })
    this.unsubs.set(id, off)
  }

  /** 注销一个远程主机（本机不可移除）。 */
  removeHost(id: string): void {
    if (id === this.localId) return
    this.unsubs.get(id)?.()
    this.unsubs.delete(id)
    this.hosts.delete(id)
    for (const [sid, hid] of this.routes) if (hid === id) this.routes.delete(sid)
    for (const [taskId, hid] of this.taskRoutes) if (hid === id) this.taskRoutes.delete(taskId)
  }

  hasHost(id: string): boolean {
    return this.hosts.has(id)
  }

  private get local(): RuntimeHost {
    return this.hosts.get(this.localId) as RuntimeHost
  }

  /** 按 sessionId 找归属主机；未知则回退本机。 */
  private route(sessionId: string): RuntimeHost {
    const id = this.routes.get(sessionId) ?? this.localId
    return this.hosts.get(id) ?? this.local
  }

  private record(hostId: string, ...ids: Array<string | null | undefined>): void {
    for (const id of ids) if (id) this.routes.set(id, hostId)
  }

  private taskHost(taskId: string): RuntimeHost {
    const hostId = this.taskRoutes.get(taskId)
    if (!hostId) throw new Error('任务归属未知，请刷新任务列表')
    const host = this.hosts.get(hostId)
    if (!host) throw new Error('任务所在 Runtime Host 不可用')
    return host
  }

  // ── 握手/状态：本机 ──────────────────────────────────────────────
  hello(): Promise<RuntimeHello> {
    return this.local.hello()
  }
  hostStatus(): Promise<RuntimeHostStatus> {
    return this.local.hostStatus()
  }

  // ── 聚合方法：合并各主机 + 打 runtimeHostId ───────────────────────
  async listRuntimes(): Promise<RuntimeInfo[]> {
    const out: RuntimeInfo[] = []
    for (const [id, host] of this.hosts) {
      const runtimes = await host.listRuntimes().catch(() => [] as RuntimeInfo[])
      for (const r of runtimes) out.push({ ...r, runtimeHostId: id })
    }
    return out
  }
  /** SPEC-033：按 hostId 取某工具的模型（远程节点走 RPC；缺省/未知 host 回本机）。 */
  async listModels(toolId: string, hostId?: string): Promise<ToolModelCatalog> {
    const id = hostId && this.hosts.has(hostId) ? hostId : this.localId
    const host = this.hosts.get(id) ?? this.local
    return host.listModels(toolId).catch(() => ({
      models: [],
      source: 'unavailable' as const,
      supportsCustomModel: true
    }))
  }
  async listDirectories(input: ListRuntimeDirectoriesInput = {}): Promise<RuntimeDirectoryListing> {
    const id = input.hostId && this.hosts.has(input.hostId) ? input.hostId : this.localId
    const host = this.hosts.get(id) ?? this.local
    const listing = await host.listDirectories({ ...input, hostId: id })
    return { ...listing, hostId: id }
  }
  async listSessions(): Promise<WorkbenchSession[]> {
    const out: WorkbenchSession[] = []
    for (const [id, host] of this.hosts) {
      const sessions = await host.listSessions().catch(() => [] as WorkbenchSession[])
      for (const s of sessions) {
        this.record(id, s.id, s.terminalSessionId, s.linkedSessionId)
        out.push({ ...s, runtimeHostId: id })
      }
    }
    return out
  }
  async listSessionViews(): Promise<WorkbenchSessionView[]> {
    const out: WorkbenchSessionView[] = []
    for (const [id, host] of this.hosts) {
      const views = await host.listSessionViews().catch(() => [] as WorkbenchSessionView[])
      for (const v of views) {
        this.record(id, v.id, v.terminalSessionId, v.linkedSessionId)
        out.push({ ...v, runtimeHostId: id })
      }
    }
    return sortSessionViews(out)
  }
  async states(): Promise<TerminalRunState[]> {
    const out: TerminalRunState[] = []
    for (const [id, host] of this.hosts) {
      const states = await host.states().catch(() => [] as TerminalRunState[])
      for (const s of states) {
        this.record(id, s.sessionId)
        out.push(s)
      }
    }
    return out
  }
  async listTasks(): Promise<AgentTask[]> {
    const out: AgentTask[] = []
    for (const [id, host] of this.hosts) {
      const tasks = await host.listTasks().catch(() => [] as AgentTask[])
      for (const task of tasks) {
        this.taskRoutes.set(task.id, id)
        out.push({ ...task, runtimeHostId: id })
      }
    }
    return out
  }

  // ── createSession：按 runtimeHostId 选目标主机 ────────────────────
  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    const hostId =
      input.runtimeHostId && this.hosts.has(input.runtimeHostId)
        ? input.runtimeHostId
        : this.localId
    const host = this.hosts.get(hostId) ?? this.local
    const handle = await host.createSession(input)
    this.record(hostId, handle.session?.id, handle.terminal?.sessionId)
    this.analytics.sessionCreated?.(input, handle)
    return handle
  }

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    const hostId =
      input.runtimeHostId && this.hosts.has(input.runtimeHostId)
        ? input.runtimeHostId
        : this.localId
    const host = this.hosts.get(hostId) ?? this.local
    const task = await host.createTask(input)
    this.taskRoutes.set(task.id, hostId)
    const stamped = { ...task, runtimeHostId: hostId }
    this.analytics.taskCreated?.(input, stamped)
    return stamped
  }

  async listTaskRuns(taskId: string): Promise<TaskRun[]> {
    return this.taskHost(taskId).listTaskRuns(taskId)
  }

  async updateTask(id: string, patch: UpdateTaskPatch): Promise<AgentTask | null> {
    const hostId = this.taskRoutes.get(id)
    const updated = await this.taskHost(id).updateTask(id, patch)
    return updated && hostId ? { ...updated, runtimeHostId: hostId } : updated
  }

  async removeTask(id: string): Promise<void> {
    await this.taskHost(id).removeTask(id)
    this.taskRoutes.delete(id)
  }

  runTaskNow(id: string): Promise<TaskRun> {
    return this.taskHost(id).runTaskNow(id)
  }

  // ── 会话级方法：路由到归属主机 ────────────────────────────────────
  resumeSession(id: string): Promise<RuntimeSessionHandle> {
    return this.route(id).resumeSession(id)
  }
  openLinkedTerminal(id: string): Promise<RuntimeSessionHandle> {
    return this.route(id).openLinkedTerminal(id)
  }
  updateSession(id: string, patch: UpdateSessionPatch): Promise<WorkbenchSession | null> {
    return this.route(id).updateSession(id, patch)
  }
  removeSession(id: string): Promise<void> {
    return this.route(id).removeSession(id)
  }
  write(sessionId: string, data: string): Promise<boolean> {
    return this.route(sessionId).write(sessionId, data)
  }
  resize(sessionId: string, cols: number, rows: number): Promise<boolean> {
    return this.route(sessionId).resize(sessionId, cols, rows)
  }
  history(sessionId: string): Promise<string> {
    return this.route(sessionId).history(sessionId)
  }
  state(sessionId: string): Promise<TerminalRunState | null> {
    return this.route(sessionId).state(sessionId)
  }
  kill(sessionId: string): Promise<boolean> {
    return this.route(sessionId).kill(sessionId)
  }
  sendTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    return this.route(sessionId).sendTurn(sessionId, text, files)
  }
  steerTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    return this.route(sessionId).steerTurn(sessionId, text, files)
  }
  queueTurn(sessionId: string, text: string, files?: string[]): Promise<ManagedQueuedTurn> {
    return this.route(sessionId).queueTurn(sessionId, text, files)
  }
  listQueuedTurns(sessionId: string): Promise<ManagedQueuedTurn[]> {
    return this.route(sessionId).listQueuedTurns(sessionId)
  }
  cancelQueuedTurn(sessionId: string, queuedTurnId: string): Promise<boolean> {
    return this.route(sessionId).cancelQueuedTurn(sessionId, queuedTurnId)
  }
  interruptTurn(sessionId: string): Promise<boolean> {
    return this.route(sessionId).interruptTurn(sessionId)
  }
  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<ChatTurnState> {
    return this.route(sessionId).respondPermission(sessionId, requestId, decision)
  }
  chatState(sessionId: string): Promise<ChatTurnState> {
    return this.route(sessionId).chatState(sessionId)
  }
  chatHistory(sessionId: string): Promise<ManagedChatMessage[]> {
    return this.route(sessionId).chatHistory(sessionId)
  }
  chatTimeline(sessionId: string): Promise<ManagedChatTimelineItem[]> {
    return this.route(sessionId).chatTimeline(sessionId)
  }
  attach(sessionId: string): AsyncIterable<HostEvent> {
    return this.route(sessionId).attach(sessionId)
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
