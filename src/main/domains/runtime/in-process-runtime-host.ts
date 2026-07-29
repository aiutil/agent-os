import type { CliAdapter } from '../adapters/types'
import { buildSessionViews } from '../sessions/view'
import { sanitizeTranscriptTitle, shouldAutoRenameSessionName } from '@shared/transcript/title'
import type {
  AdapterSessionStorage,
  AgentTask,
  AgentEvent,
  ChatTurnState,
  CreateSessionInput,
  CreateTaskInput,
  HostEvent,
  ListRuntimeDirectoriesInput,
  ManagedChatMessage,
  ManagedQueuedTurn,
  ManagedChatTimelineItem,
  RuntimeDirectoryListing,
  RuntimeHello,
  RuntimeHostStatus,
  RuntimeInfo,
  RuntimeSessionHandle,
  TerminalRunState,
  TaskChangedEvent,
  TaskRun,
  ToolModelCatalog,
  UpdateSessionPatch,
  UpdateTaskPatch,
  WorkbenchSession,
  WorkbenchSessionView
} from '@shared/types'
import type { PermissionDecision } from '@shared/types'
import { RUNTIME_PROTOCOL_VERSION } from '@shared/types'
import type {
  RuntimeEventListener,
  RuntimeChat,
  RuntimeHost,
  RuntimeSessionRepository,
  RuntimeTasks,
  RuntimeTerminal
} from './protocol'
import { listRuntimeDirectories } from './directory-browser'

type ObserveNativeSession = (options: {
  storage: AdapterSessionStorage
  cwd: string
}) => Promise<string | null>

type NativeSessionExists = (
  storage: AdapterSessionStorage,
  cwd: string,
  nativeSessionId: string
) => Promise<boolean>

export interface InProcessRuntimeHostOptions {
  terminal: RuntimeTerminal
  chat: RuntimeChat
  sessions: RuntimeSessionRepository
  getAdapter(toolId: string): CliAdapter | undefined
  observeNativeSession: ObserveNativeSession
  nativeSessionExists: NativeSessionExists
  createNativeSessionId(): string
  getProviderEnv(toolId: string): Record<string, string>
  getProviderModel?(toolId: string): string | undefined
  hostVersion: string
  runtimeBuildId?: string
  listRuntimes(): Promise<RuntimeInfo[]>
  /** 某工具可选模型（缺省返回空）。SPEC-033：远程节点经 RPC 也走此路径。 */
  listModels?(toolId: string): Promise<ToolModelCatalog>
  tasks?: RuntimeTasks
}

function resumeError(
  code: 'NO_NATIVE_ID' | 'RESUME_UNSUPPORTED' | 'RESUME_FAILED',
  message: string
): Error {
  return new Error(`[${code}] ${message}`)
}

function isActiveTerminalStatus(status: TerminalRunState['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'waiting_input'
}

export class InProcessRuntimeHost implements RuntimeHost {
  private readonly listeners = new Set<RuntimeEventListener>()

  constructor(private readonly options: InProcessRuntimeHostOptions) {
    options.terminal.setEmit((channel, payload) => {
      const event = this.normalizeTerminalEvent(channel, payload)
      if (!event) return
      for (const listener of this.listeners) listener(event)
    })
  }

  async hello(): Promise<RuntimeHello> {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      hostVersion: this.options.hostVersion,
      runtimeBuildId: this.options.runtimeBuildId ?? this.options.hostVersion
    }
  }

  async hostStatus(): Promise<RuntimeHostStatus> {
    return {
      mode: 'in-process',
      connection: 'connected',
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      hostVersion: this.options.hostVersion,
      runtimeBuildId: this.options.runtimeBuildId ?? this.options.hostVersion,
      sessionCount: this.options.sessions.listSessions().length
    }
  }

  async listRuntimes(): Promise<RuntimeInfo[]> {
    return this.options.listRuntimes()
  }

  async listModels(toolId: string): Promise<ToolModelCatalog> {
    return (
      this.options.listModels?.(toolId) ?? {
        models: [],
        source: 'unavailable',
        supportsCustomModel: false
      }
    )
  }

  async listDirectories(input?: ListRuntimeDirectoriesInput): Promise<RuntimeDirectoryListing> {
    return listRuntimeDirectories(input)
  }

  async listSessions(): Promise<WorkbenchSession[]> {
    return this.options.sessions.listSessions()
  }

  async listSessionViews(): Promise<WorkbenchSessionView[]> {
    const sessions = await this.reconcileStoredSessionTitles()
    return buildSessionViews(sessions, this.options.terminal.listStates(), (toolId) =>
      Boolean(this.options.getAdapter(toolId)?.buildResumeCommand)
    ).map((view) => {
      if (view.surface !== 'chat') return view
      const chat = this.options.chat.state(view.id)
      if (chat.status === 'running') {
        return { ...view, status: 'running', lastActivityAt: chat.updatedAt }
      }
      if (chat.status === 'awaiting-permission') {
        return {
          ...view,
          status: 'waiting_input',
          outputTail: chat.pendingPermission?.toolName ?? '',
          lastActivityAt: chat.updatedAt
        }
      }
      if (chat.status === 'failed') {
        return {
          ...view,
          status: 'failed',
          outputTail: chat.error ?? '',
          lastActivityAt: chat.updatedAt
        }
      }
      return view
    })
  }

  /**
   * SPEC-035 v2：以 runtime 为标题写入单一责任方，并在读取列表时幂等修复存量坏标题。
   * 仅坏/provisional chat 需要读取 SQLite 历史；正常标题不做额外 I/O。
   */
  private async reconcileStoredSessionTitles(): Promise<WorkbenchSession[]> {
    const sessions = this.options.sessions.listSessions()
    await Promise.all(
      sessions.map(async (session) => {
        const workspaceBase = session.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? ''
        const sanitizedName = sanitizeTranscriptTitle(session.name, 80)
        if (
          session.surface === 'chat' &&
          shouldAutoRenameSessionName(session.name, {
            nameProvisional: session.nameProvisional,
            workspaceBase
          })
        ) {
          let history: ManagedChatMessage[] = []
          try {
            history = this.options.chat.history(session.id)
          } catch {
            // 历史存储暂不可用时保留原名，下一次 listViews 会重试。
          }
          const firstUserTitle = history
            .filter((message) => message.role === 'user')
            .map((message) => sanitizeTranscriptTitle(message.text, 80))
            .find(Boolean)
          const title = firstUserTitle || sanitizedName
          if (title && (title !== session.name || session.nameProvisional)) {
            this.options.sessions.updateSession(session.id, {
              name: title,
              nameProvisional: false
            })
          }
          return
        }
        if (sanitizedName && sanitizedName !== session.name) {
          this.options.sessions.updateSession(session.id, { name: sanitizedName })
        }
      })
    )
    return this.options.sessions.listSessions()
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    const adapter = this.options.getAdapter(input.toolId)
    if (!adapter) throw new Error(`未知的 CLI 适配器：${input.toolId}`)

    const session = this.options.sessions.createSession(input)
    if (session.surface === 'chat') {
      if (!adapter.headlessJson) {
        this.options.sessions.removeSession(session.id)
        throw new Error('该 CLI 暂不支持对话镜头')
      }
      return { session, terminal: null }
    }
    const injectedNativeId = adapter.supportsSessionIdInjection
      ? this.options.createNativeSessionId()
      : null
    if (injectedNativeId) {
      this.options.sessions.bindNativeSession(session.id, injectedNativeId)
    }
    const observedNativeId =
      !injectedNativeId && adapter.sessionStorage
        ? this.options.observeNativeSession({
            storage: adapter.sessionStorage,
            cwd: input.workspacePath
          })
        : null
    const command = adapter.buildLaunchCommand({
      cwd: input.workspacePath,
      model: input.model ?? this.options.getProviderModel?.(input.toolId),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      nativeSessionId: injectedNativeId ?? undefined
    })
    const terminal = this.options.terminal.openSession({
      toolId: input.toolId,
      cwd: input.workspacePath,
      command,
      env: this.options.getProviderEnv(input.toolId)
    })
    const attached = this.options.sessions.attachTerminal(session.id, terminal.sessionId) ?? session
    this.options.terminal.onExit(terminal.sessionId, () => {
      this.options.sessions.attachTerminal(session.id, null)
    })

    if (observedNativeId) {
      void observedNativeId.then((nativeSessionId) => {
        if (nativeSessionId) {
          this.options.sessions.bindNativeSession(session.id, nativeSessionId)
        }
      })
    }
    return { session: attached, terminal }
  }

  async resumeSession(id: string): Promise<RuntimeSessionHandle> {
    const session = this.options.sessions.getSession(id)
    if (session?.surface === 'chat' || session?.mode === 'chat') {
      throw resumeError('RESUME_UNSUPPORTED', '聊天会话不能直接执行终端恢复')
    }
    if (session?.terminalSessionId) {
      const state = this.options.terminal.getState(session.terminalSessionId)
      if (state && isActiveTerminalStatus(state.status)) {
        return {
          session,
          terminal: {
            sessionId: state.sessionId,
            toolId: state.toolId,
            cwd: state.workspacePath,
            command: state.command,
            backend: state.backend,
            createdAt: state.startedAt
          }
        }
      }
      this.options.sessions.attachTerminal(session.id, null)
    }
    if (!session?.nativeSessionId) {
      throw resumeError('NO_NATIVE_ID', '该会话没有可恢复的原生会话 id')
    }
    const adapter = this.options.getAdapter(session.toolId)
    if (!adapter?.buildResumeCommand) {
      throw resumeError('RESUME_UNSUPPORTED', '该 CLI 不支持恢复原生会话')
    }
    if (
      adapter.sessionStorage &&
      !(await this.options.nativeSessionExists(
        adapter.sessionStorage,
        session.workspacePath,
        session.nativeSessionId
      ))
    ) {
      this.options.sessions.bindNativeSession(id, null)
      throw resumeError('RESUME_FAILED', '原生会话文件已失效')
    }

    const command = adapter.buildResumeCommand(session.nativeSessionId, session.workspacePath)
    const terminal = this.options.terminal.openSession({
      toolId: session.toolId,
      cwd: session.workspacePath,
      command,
      env: this.options.getProviderEnv(session.toolId)
    })
    const attached = this.options.sessions.attachTerminal(session.id, terminal.sessionId) ?? session
    this.options.terminal.onExit(terminal.sessionId, () => {
      this.options.sessions.attachTerminal(session.id, null)
    })
    return { session: attached, terminal }
  }

  async openLinkedTerminal(id: string): Promise<RuntimeSessionHandle> {
    const source = this.options.sessions.getSession(id)
    if (!source || (source.surface !== 'chat' && source.mode !== 'chat')) {
      throw resumeError('RESUME_UNSUPPORTED', '仅聊天会话可创建关联终端')
    }
    if (!source.nativeSessionId) {
      throw resumeError('NO_NATIVE_ID', '该对话尚未建立原生会话，无法在终端打开')
    }
    const adapter = this.options.getAdapter(source.toolId)
    if (!adapter?.buildResumeCommand) {
      throw resumeError('RESUME_UNSUPPORTED', '该 Agent 不支持从聊天衔接到终端')
    }
    if (source.linkedSessionId) {
      const existing = this.options.sessions.getSession(source.linkedSessionId)
      if (existing && existing.surface === 'terminal') {
        if (!existing.nativeSessionId) {
          this.options.sessions.bindNativeSession(existing.id, source.nativeSessionId)
        }
        return this.resumeSession(existing.id)
      }
    }
    const linked = this.options.sessions.createSession({
      name: `${source.name} (CLI)`,
      toolId: source.toolId,
      workspacePath: source.workspacePath,
      surface: 'terminal',
      permissionPreset: source.permissionPreset
    })
    this.options.sessions.bindNativeSession(linked.id, source.nativeSessionId)
    try {
      const resumed = await this.resumeSession(linked.id)
      this.options.sessions.linkSessions(source.id, linked.id)
      return {
        ...resumed,
        session: this.options.sessions.getSession(linked.id) ?? resumed.session
      }
    } catch (error) {
      this.options.sessions.removeSession(linked.id)
      throw error
    }
  }

  async updateSession(id: string, patch: UpdateSessionPatch): Promise<WorkbenchSession | null> {
    return this.options.sessions.updateSession(id, patch)
  }

  async removeSession(id: string): Promise<void> {
    const session = this.options.sessions.getSession(id)
    if (session?.terminalSessionId) {
      this.options.terminal.close(session.terminalSessionId)
    }
    await this.options.chat.interrupt(id)
    await this.options.chat.forgetSession?.(id)
    this.options.sessions.removeSession(id)
  }

  async write(sessionId: string, data: string): Promise<boolean> {
    return this.options.terminal.write(sessionId, data)
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<boolean> {
    return this.options.terminal.resize(sessionId, cols, rows)
  }

  async history(sessionId: string): Promise<string> {
    return this.options.terminal.getHistory(sessionId)
  }

  async state(sessionId: string): Promise<TerminalRunState | null> {
    return this.options.terminal.getState(sessionId)
  }

  async states(): Promise<TerminalRunState[]> {
    return this.options.terminal.listStates()
  }

  async kill(sessionId: string): Promise<boolean> {
    return this.options.terminal.close(sessionId)
  }

  async sendTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    const turn = await this.options.chat.sendTurn(sessionId, text, files)
    this.finalizeChatTitle(sessionId, text)
    return turn
  }

  async steerTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    const turn = await this.options.chat.steer(sessionId, text, files)
    this.finalizeChatTitle(sessionId, text)
    return turn
  }

  async queueTurn(sessionId: string, text: string, files?: string[]): Promise<ManagedQueuedTurn> {
    const turn = await this.options.chat.queueTurn(sessionId, text, files)
    this.finalizeChatTitle(sessionId, text)
    return turn
  }

  private finalizeChatTitle(sessionId: string, text: string): void {
    const session = this.options.sessions.getSession(sessionId)
    if (!session || session.surface !== 'chat') return
    const workspaceBase = session.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? ''
    if (
      !shouldAutoRenameSessionName(session.name, {
        nameProvisional: session.nameProvisional,
        workspaceBase
      })
    )
      return
    const title = sanitizeTranscriptTitle(text, 80)
    if (!title) return
    this.options.sessions.updateSession(sessionId, { name: title, nameProvisional: false })
  }

  async listQueuedTurns(sessionId: string): Promise<ManagedQueuedTurn[]> {
    return this.options.chat.listQueuedTurns(sessionId)
  }

  async cancelQueuedTurn(sessionId: string, queuedTurnId: string): Promise<boolean> {
    return this.options.chat.cancelQueuedTurn(sessionId, queuedTurnId)
  }

  async interruptTurn(sessionId: string): Promise<boolean> {
    return this.options.chat.interrupt(sessionId)
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<ChatTurnState> {
    return this.options.chat.respondPermission(sessionId, requestId, decision)
  }

  async chatState(sessionId: string): Promise<ChatTurnState> {
    return this.options.chat.state(sessionId)
  }

  async chatHistory(sessionId: string): Promise<ManagedChatMessage[]> {
    return this.options.chat.history(sessionId)
  }

  async chatTimeline(sessionId: string): Promise<ManagedChatTimelineItem[]> {
    return this.options.chat.timeline(sessionId)
  }

  async listTasks(): Promise<AgentTask[]> {
    return this.options.tasks?.listTasks() ?? []
  }

  async listTaskRuns(taskId: string): Promise<TaskRun[]> {
    return this.options.tasks?.listTaskRuns(taskId) ?? []
  }

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    if (!this.options.tasks) throw new Error('当前 Runtime Host 不支持任务调度')
    return this.options.tasks.createTask(input)
  }

  async updateTask(id: string, patch: UpdateTaskPatch): Promise<AgentTask | null> {
    if (!this.options.tasks) throw new Error('当前 Runtime Host 不支持任务调度')
    return this.options.tasks.updateTask(id, patch)
  }

  async removeTask(id: string): Promise<void> {
    if (!this.options.tasks) throw new Error('当前 Runtime Host 不支持任务调度')
    this.options.tasks.removeTask(id)
  }

  async runTaskNow(id: string): Promise<TaskRun> {
    if (!this.options.tasks) throw new Error('当前 Runtime Host 不支持任务调度')
    return this.options.tasks.runTaskNow(id)
  }

  attach(sessionId: string): AsyncIterable<HostEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const queue: HostEvent[] = []
        const waiters: Array<(result: IteratorResult<HostEvent>) => void> = []
        let closed = false
        const unsubscribe = this.subscribe((event) => {
          if (!('sessionId' in event) || event.sessionId !== sessionId || closed) return
          const waiter = waiters.shift()
          if (waiter) waiter({ value: event, done: false })
          else queue.push(event)
        })

        return {
          next: (): Promise<IteratorResult<HostEvent>> => {
            const event = queue.shift()
            if (event) return Promise.resolve({ value: event, done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => waiters.push(resolve))
          },
          return: (): Promise<IteratorResult<HostEvent>> => {
            closed = true
            unsubscribe()
            for (const waiter of waiters.splice(0)) {
              waiter({ value: undefined, done: true })
            }
            return Promise.resolve({ value: undefined, done: true })
          }
        }
      }
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitAgentEvent(
    sessionId: string,
    event: AgentEvent,
    timelineItem?: ManagedChatTimelineItem,
    turnId?: string
  ): void {
    for (const listener of this.listeners) {
      listener({
        kind: 'agent-event',
        sessionId,
        event,
        ...(turnId || timelineItem?.turnId ? { turnId: turnId ?? timelineItem!.turnId } : {}),
        ...(timelineItem ? { seq: timelineItem.seq, timelineItem } : {})
      })
    }
  }

  emitTaskChanged(event: TaskChangedEvent): void {
    for (const listener of this.listeners) listener({ kind: 'task-changed', event })
  }

  private normalizeTerminalEvent(channel: string, payload: unknown): HostEvent | null {
    if (channel === 'terminal:data') {
      const event = payload as { sessionId: string; data: string }
      return {
        kind: 'pty-data',
        sessionId: event.sessionId,
        bytes: event.data
      }
    }
    if (channel === 'terminal:stateChanged') {
      const event = payload as Extract<HostEvent, { kind: 'state' }>
      return {
        kind: 'state',
        sessionId: event.sessionId,
        state: event.state,
        prevStatus: event.prevStatus
      }
    }
    if (channel === 'terminal:exit') {
      const event = payload as { sessionId: string; exitCode: number }
      return { kind: 'exit', sessionId: event.sessionId, code: event.exitCode }
    }
    return null
  }
}
