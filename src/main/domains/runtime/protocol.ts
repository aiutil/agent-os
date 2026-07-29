import type {
  CreateSessionInput,
  ChatTurnState,
  HostEvent,
  LaunchTerminalInput,
  ListRuntimeDirectoriesInput,
  ManagedChatMessage,
  ManagedChatMessageStatus,
  ManagedQueuedTurn,
  ManagedChatTimelineItem,
  RuntimeHost,
  RuntimeDirectoryListing,
  TerminalRunState,
  TerminalSessionInfo,
  UpdateSessionPatch,
  WorkbenchSession,
  PermissionDecision
} from '@shared/types'
import type { AgentTask, CreateTaskInput, TaskRun, UpdateTaskPatch } from '@shared/types'

export type { RuntimeHost }

export type RuntimeEventListener = (event: HostEvent) => void

export interface RuntimeTerminal {
  setEmit(emit: (channel: string, payload: unknown) => void): void
  openSession(input: LaunchTerminalInput): TerminalSessionInfo
  write(sessionId: string, data: string): boolean
  resize(sessionId: string, cols: number, rows: number): boolean
  getHistory(sessionId: string): string
  getState(sessionId: string): TerminalRunState | null
  listStates(): TerminalRunState[]
  close(sessionId: string): boolean
  onExit(
    sessionId: string,
    listener: (exitCode: number, intentionallyClosed: boolean) => void
  ): void
}

export interface RuntimeChat {
  state(sessionId: string): ChatTurnState
  sendTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState>
  steer(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState>
  queueTurn(sessionId: string, text: string, files?: string[]): ManagedQueuedTurn
  listQueuedTurns(sessionId: string): ManagedQueuedTurn[]
  cancelQueuedTurn(sessionId: string, queuedTurnId: string): boolean
  interrupt(sessionId: string): Promise<boolean>
  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<ChatTurnState>
  history(sessionId: string): ManagedChatMessage[]
  timeline(sessionId: string): ManagedChatTimelineItem[]
  /** 删除会话后释放仅与该会话相关的内存态；持久化仓储由 RuntimeHost 另行删除。 */
  forgetSession?(sessionId: string): Promise<void>
}

export interface RuntimeTasks {
  listTasks(): AgentTask[]
  listTaskRuns(taskId: string): TaskRun[]
  createTask(input: CreateTaskInput): AgentTask
  updateTask(id: string, patch: UpdateTaskPatch): AgentTask | null
  removeTask(id: string): void
  runTaskNow(id: string): TaskRun
}

export type { ListRuntimeDirectoriesInput, RuntimeDirectoryListing }

export interface RuntimeSessionRepository {
  listSessions(): WorkbenchSession[]
  getSession(id: string): WorkbenchSession | null
  createSession(input: CreateSessionInput): WorkbenchSession
  bindNativeSession(id: string, nativeSessionId: string | null): WorkbenchSession | null
  updateSession(id: string, patch: UpdateSessionPatch): WorkbenchSession | null
  attachTerminal(id: string, terminalSessionId: string | null): WorkbenchSession | null
  listChatHistory(id: string): ManagedChatMessage[]
  appendChatMessage(
    id: string,
    message: Omit<ManagedChatMessage, 'id' | 'createdAt' | 'updatedAt'>
  ): ManagedChatMessage
  updateChatMessage(
    id: string,
    messageId: string,
    patch: { text?: string; status?: ManagedChatMessageStatus }
  ): ManagedChatMessage | null
  linkSessions(sourceId: string, linkedId: string): void
  removeSession(id: string): void
}
