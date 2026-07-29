// SPEC-032 v2：把本机 Runtime 缩成某一条方向性授权可见、可操作的最小视图。

import type {
  AgentTask,
  ChatTurnState,
  CreateSessionInput,
  CreateTaskInput,
  HostEvent,
  ListRuntimeDirectoriesInput,
  ManagedChatMessage,
  ManagedChatTimelineItem,
  ManagedDeviceAuthorization,
  ManagedDeviceCapability,
  ManagedQueuedTurn,
  ManagedSessionOwnership,
  PermissionDecision,
  RuntimeDirectoryListing,
  RuntimeHello,
  RuntimeHostStatus,
  RuntimeInfo,
  RuntimeSessionHandle,
  TaskRun,
  TerminalRunState,
  ToolModelCatalog,
  UpdateSessionPatch,
  UpdateTaskPatch,
  WorkbenchSession,
  WorkbenchSessionView
} from '@shared/types'
import type { RuntimeHost } from './protocol'
import { DeviceAuthorizationRegistry } from './device-authorization'

export interface ManagedSessionOwnershipStore {
  get(): ManagedSessionOwnership[]
  set(ownerships: ManagedSessionOwnership[]): void
}

export interface AuthorizedRuntimeContext {
  authorizationId: string
  controllerDeviceId: string
  credential: string
}

interface ManagedAuthorizationRequestState {
  blocked: boolean
  inFlight: number
  drained: Set<() => void>
}

/** 撤销屏障：先封锁新 RPC，再等待已经受理的 RPC 全部执行 finally。 */
export class ManagedAuthorizationRequestTracker {
  private readonly states = new Map<string, ManagedAuthorizationRequestState>()

  begin(authorizationId: string): () => void {
    const state = this.state(authorizationId)
    if (state.blocked) throw new Error('远程授权拒绝：授权连接已暂停或撤销')
    state.inFlight += 1
    let released = false
    return () => {
      if (released) return
      released = true
      state.inFlight -= 1
      if (state.inFlight !== 0) return
      for (const resolve of state.drained) resolve()
      state.drained.clear()
    }
  }

  block(authorizationId: string): void {
    this.state(authorizationId).blocked = true
  }

  allow(authorizationId: string): void {
    this.state(authorizationId).blocked = false
  }

  drain(authorizationId: string): Promise<void> {
    const state = this.state(authorizationId)
    if (state.inFlight === 0) return Promise.resolve()
    return new Promise((resolve) => state.drained.add(resolve))
  }

  private state(authorizationId: string): ManagedAuthorizationRequestState {
    let state = this.states.get(authorizationId)
    if (!state) {
      state = { blocked: false, inFlight: 0, drained: new Set() }
      this.states.set(authorizationId, state)
    }
    return state
  }
}

export class ManagedSessionOwnershipRegistry {
  constructor(private readonly store: ManagedSessionOwnershipStore) {}

  list(authorizationId: string): ManagedSessionOwnership[] {
    return this.store.get().filter((item) => item.authorizationId === authorizationId)
  }

  ownsSession(authorizationId: string, sessionId: string): boolean {
    return this.list(authorizationId).some((item) => item.sessionId === sessionId)
  }

  ownsTerminal(authorizationId: string, terminalSessionId: string): boolean {
    return this.list(authorizationId).some((item) => item.terminalSessionId === terminalSessionId)
  }

  track(authorizationId: string, handle: RuntimeSessionHandle): void {
    const now = new Date().toISOString()
    const previous = this.store.get()
    const existing = previous.find((item) => item.sessionId === handle.session.id)
    if (existing && existing.authorizationId !== authorizationId) {
      throw new Error('会话已属于另一条方向性授权')
    }
    if (
      handle.terminal?.sessionId &&
      previous.some(
        (item) =>
          item.sessionId !== handle.session.id &&
          item.terminalSessionId === handle.terminal!.sessionId
      )
    ) {
      throw new Error('PTY 已属于另一条远程会话')
    }
    const next: ManagedSessionOwnership = {
      authorizationId,
      sessionId: handle.session.id,
      ...(handle.terminal?.sessionId ? { terminalSessionId: handle.terminal.sessionId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.store.set([...previous.filter((item) => item.sessionId !== handle.session.id), next])
  }

  remove(authorizationId: string, sessionId: string): void {
    this.store.set(
      this.store
        .get()
        .filter(
          (item) => !(item.authorizationId === authorizationId && item.sessionId === sessionId)
        )
    )
  }

  async terminate(authorizationId: string, runtime: RuntimeHost): Promise<void> {
    for (const ownership of this.list(authorizationId)) {
      if (ownership.terminalSessionId)
        await runtime.kill(ownership.terminalSessionId).catch(() => false)
      await runtime.interruptTurn(ownership.sessionId).catch(() => false)
    }
  }
}

export class AuthorizedRuntimeHost implements RuntimeHost {
  constructor(
    private readonly runtime: RuntimeHost,
    private readonly authorizations: DeviceAuthorizationRegistry,
    private readonly ownerships: ManagedSessionOwnershipRegistry,
    private readonly context: AuthorizedRuntimeContext
  ) {}

  private require(
    capability: ManagedDeviceCapability,
    workspacePath?: string
  ): ManagedDeviceAuthorization {
    const decision = this.authorizations.authorize({ ...this.context, capability, workspacePath })
    if (!decision.allowed) throw new Error(`远程授权拒绝：${decision.reason}`)
    return decision.authorization
  }

  private requireOwnedSession(capability: ManagedDeviceCapability, sessionId: string): void {
    this.require(capability)
    if (!this.ownerships.ownsSession(this.context.authorizationId, sessionId)) {
      throw new Error('远程授权拒绝：会话不属于当前授权')
    }
  }

  private requireOwnedTerminal(
    capability: ManagedDeviceCapability,
    terminalSessionId: string
  ): void {
    this.require(capability)
    if (!this.ownerships.ownsTerminal(this.context.authorizationId, terminalSessionId)) {
      throw new Error('远程授权拒绝：PTY 不属于当前授权')
    }
  }

  private ownsEvent(event: HostEvent): boolean {
    if (event.kind === 'task-changed') return false
    if (
      !this.authorizations.authorize({
        ...this.context,
        capability: 'session:read'
      }).allowed
    )
      return false
    return event.kind === 'agent-event'
      ? this.ownerships.ownsSession(this.context.authorizationId, event.sessionId)
      : this.ownerships.ownsTerminal(this.context.authorizationId, event.sessionId)
  }

  async hello(): Promise<RuntimeHello> {
    this.require('runtime:status')
    return this.runtime.hello()
  }

  async hostStatus(): Promise<RuntimeHostStatus> {
    this.require('runtime:status')
    const status = await this.runtime.hostStatus()
    return { ...status, sessionCount: this.ownerships.list(this.context.authorizationId).length }
  }

  async listRuntimes(): Promise<RuntimeInfo[]> {
    this.require('runtime:list-agents')
    return (await this.runtime.listRuntimes()).map(
      ({ executablePath: _path, ...runtime }) => runtime
    )
  }

  async listModels(toolId: string): Promise<ToolModelCatalog> {
    this.require('runtime:list-agents')
    return this.runtime.listModels(toolId)
  }

  async listDirectories(input?: ListRuntimeDirectoriesInput): Promise<RuntimeDirectoryListing> {
    const configured = this.authorizations
      .list()
      .find((item) => item.id === this.context.authorizationId)
    const path = input?.path ?? configured?.allowedRoots[0]
    if (!path) throw new Error('远程授权拒绝：未配置授权目录')
    const authorization = this.require('directory:list', path)
    const listing = await this.runtime.listDirectories({ ...input, path, hostId: undefined })
    const entries = listing.entries.filter(
      (entry) =>
        this.authorizations.authorize({
          ...this.context,
          capability: 'directory:list',
          workspacePath: entry.path
        }).allowed
    )
    const parentAllowed =
      listing.parent &&
      this.authorizations.authorize({
        ...this.context,
        capability: 'directory:list',
        workspacePath: listing.parent
      }).allowed
    return {
      path: listing.path,
      home: authorization.allowedRoots[0] ?? listing.path,
      entries,
      ...(parentAllowed ? { parent: listing.parent } : {})
    }
  }

  async listSessions(): Promise<WorkbenchSession[]> {
    this.require('session:read')
    const owned = new Set(
      this.ownerships.list(this.context.authorizationId).map((item) => item.sessionId)
    )
    return (await this.runtime.listSessions()).filter((session) => owned.has(session.id))
  }

  async listSessionViews(): Promise<WorkbenchSessionView[]> {
    this.require('session:read')
    const owned = new Set(
      this.ownerships.list(this.context.authorizationId).map((item) => item.sessionId)
    )
    return (await this.runtime.listSessionViews()).filter((session) => owned.has(session.id))
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    this.require('session:create', input.workspacePath)
    const handle = await this.runtime.createSession({
      name: input.name,
      nameProvisional: input.nameProvisional,
      toolId: input.toolId,
      workspacePath: input.workspacePath,
      surface: input.surface,
      permissionPreset: 'safe',
      memoryUse: false,
      memoryGenerate: false,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
    })
    try {
      this.ownerships.track(this.context.authorizationId, handle)
      return handle
    } catch (error) {
      await this.runtime.removeSession(handle.session.id).catch(() => undefined)
      throw error
    }
  }

  async resumeSession(id: string): Promise<RuntimeSessionHandle> {
    this.requireOwnedSession('session:read', id)
    const session = (await this.runtime.listSessions()).find((item) => item.id === id)
    if (!session) throw new Error('远程会话不存在')
    this.require('session:create', session.workspacePath)
    const handle = await this.runtime.resumeSession(id)
    this.ownerships.track(this.context.authorizationId, handle)
    return handle
  }

  async openLinkedTerminal(id: string): Promise<RuntimeSessionHandle> {
    this.requireOwnedSession('session:read', id)
    const source = (await this.runtime.listSessions()).find((item) => item.id === id)
    if (!source) throw new Error('远程会话不存在')
    this.require('session:create', source.workspacePath)
    const handle = await this.runtime.openLinkedTerminal(id)
    try {
      this.require('session:create', handle.session.workspacePath)
      this.ownerships.track(this.context.authorizationId, handle)
      return handle
    } catch (error) {
      if (handle.session.id !== id)
        await this.runtime.removeSession(handle.session.id).catch(() => undefined)
      throw error
    }
  }

  async updateSession(id: string, patch: UpdateSessionPatch): Promise<WorkbenchSession | null> {
    this.requireOwnedSession('session:write', id)
    return this.runtime.updateSession(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.nameProvisional !== undefined ? { nameProvisional: patch.nameProvisional } : {})
    })
  }

  async removeSession(id: string): Promise<void> {
    this.requireOwnedSession('session:terminate', id)
    await this.runtime.removeSession(id)
    this.ownerships.remove(this.context.authorizationId, id)
  }

  async write(sessionId: string, data: string): Promise<boolean> {
    this.requireOwnedTerminal('session:write', sessionId)
    return this.runtime.write(sessionId, data)
  }
  async resize(sessionId: string, cols: number, rows: number): Promise<boolean> {
    this.requireOwnedTerminal('session:write', sessionId)
    return this.runtime.resize(sessionId, cols, rows)
  }
  async history(sessionId: string): Promise<string> {
    this.requireOwnedTerminal('session:read', sessionId)
    return this.runtime.history(sessionId)
  }
  async state(sessionId: string): Promise<TerminalRunState | null> {
    this.requireOwnedTerminal('session:read', sessionId)
    return this.runtime.state(sessionId)
  }
  async states(): Promise<TerminalRunState[]> {
    this.require('session:read')
    return (await this.runtime.states()).filter((state) =>
      this.ownerships.ownsTerminal(this.context.authorizationId, state.sessionId)
    )
  }
  async kill(sessionId: string): Promise<boolean> {
    this.requireOwnedTerminal('session:terminate', sessionId)
    return this.runtime.kill(sessionId)
  }

  private checkFiles(files?: string[]): void {
    for (const file of files ?? []) this.require('session:write', file)
  }
  async sendTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    this.requireOwnedSession('session:write', sessionId)
    this.checkFiles(files)
    return this.runtime.sendTurn(sessionId, text, files)
  }
  async steerTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    this.requireOwnedSession('session:terminate', sessionId)
    this.requireOwnedSession('session:write', sessionId)
    this.checkFiles(files)
    return this.runtime.steerTurn(sessionId, text, files)
  }
  async queueTurn(sessionId: string, text: string, files?: string[]): Promise<ManagedQueuedTurn> {
    this.requireOwnedSession('session:write', sessionId)
    this.checkFiles(files)
    return this.runtime.queueTurn(sessionId, text, files)
  }
  async listQueuedTurns(sessionId: string): Promise<ManagedQueuedTurn[]> {
    this.requireOwnedSession('session:read', sessionId)
    return this.runtime.listQueuedTurns(sessionId)
  }
  async cancelQueuedTurn(sessionId: string, queuedTurnId: string): Promise<boolean> {
    this.requireOwnedSession('session:write', sessionId)
    return this.runtime.cancelQueuedTurn(sessionId, queuedTurnId)
  }
  async interruptTurn(sessionId: string): Promise<boolean> {
    this.requireOwnedSession('session:terminate', sessionId)
    return this.runtime.interruptTurn(sessionId)
  }
  async respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<ChatTurnState> {
    this.requireOwnedSession('session:write', sessionId)
    return this.runtime.respondPermission(sessionId, requestId, decision)
  }
  async chatState(sessionId: string): Promise<ChatTurnState> {
    this.requireOwnedSession('session:read', sessionId)
    return this.runtime.chatState(sessionId)
  }
  async chatHistory(sessionId: string): Promise<ManagedChatMessage[]> {
    this.requireOwnedSession('session:read', sessionId)
    return this.runtime.chatHistory(sessionId)
  }
  async chatTimeline(sessionId: string): Promise<ManagedChatTimelineItem[]> {
    this.requireOwnedSession('session:read', sessionId)
    return this.runtime.chatTimeline(sessionId)
  }

  async listTasks(): Promise<AgentTask[]> {
    throw new Error('远程授权不开放任务管理')
  }
  async listTaskRuns(_taskId: string): Promise<TaskRun[]> {
    throw new Error('远程授权不开放任务管理')
  }
  async createTask(_input: CreateTaskInput): Promise<AgentTask> {
    throw new Error('远程授权不开放任务管理')
  }
  async updateTask(_id: string, _patch: UpdateTaskPatch): Promise<AgentTask | null> {
    throw new Error('远程授权不开放任务管理')
  }
  async removeTask(_id: string): Promise<void> {
    throw new Error('远程授权不开放任务管理')
  }
  async runTaskNow(_id: string): Promise<TaskRun> {
    throw new Error('远程授权不开放任务管理')
  }

  attach(sessionId: string): AsyncIterable<HostEvent> {
    this.requireOwnedTerminal('session:read', sessionId)
    const source = this.runtime.attach(sessionId)
    const ownsEvent = (event: HostEvent): boolean => this.ownsEvent(event)
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) if (ownsEvent(event)) yield event
      }
    }
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    return this.runtime.subscribe((event) => {
      if (this.ownsEvent(event)) listener(event)
    })
  }
}
