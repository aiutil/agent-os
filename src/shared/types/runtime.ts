import type {
  CreateSessionInput,
  ManagedChatTimelineItem,
  ManagedChatMessage,
  ManagedQueuedTurn,
  UpdateSessionPatch,
  WorkbenchSession,
  WorkbenchSessionView
} from './session'
import type { ListRuntimeDirectoriesInput, RuntimeDirectoryListing } from './remote-node'
import type { TerminalRunState, TerminalRunStatus, TerminalSessionInfo } from './terminal'
import type { CliHealth, ToolModelCatalog } from './discovery'
import type { AgentEvent, ChatTurnState, PermissionDecision } from './agent-event'
import type { AgentTask, CreateTaskInput, TaskChangedEvent, TaskRun, UpdateTaskPatch } from './task'
import type { TurnContextPack } from './memory'

export const RUNTIME_PROTOCOL_VERSION = 11

export interface RuntimeAttachmentCapabilities {
  /** Agent/CLI 原生支持图片输入。 */
  images: boolean
  /** Agent/CLI 原生支持非图片文件输入。 */
  files: boolean
  /** 原生单回合数量上限；缺省表示 Agent OS 不额外限制。 */
  maxFiles?: number
  /** 已验证可传递的扩展名；缺省表示由 CLI 原生校验。 */
  allowedExtensions?: string[]
}

export interface RuntimeHello {
  protocolVersion: number
  hostVersion: string
  runtimeBuildId: string
}

export interface RuntimeCapabilities {
  terminal: boolean
  chat: boolean
  terminalResume: boolean
  chatContinuation: 'native' | 'managed-history' | 'none'
  linkedTerminal: boolean
  /** 该 Agent 原生附件能力。remote 节点的本地路径附件由前端另行禁用。 */
  attachments: RuntimeAttachmentCapabilities
}

export interface RuntimeInfo {
  toolId: string
  displayName: string
  channel: 'pty'
  canResume: boolean
  capabilities: RuntimeCapabilities
  health: CliHealth
  version?: string
  executablePath?: string
  /** 该 runtime 所属主机 id（'local' 或远程节点 id）；联邦层填充。 */
  runtimeHostId?: string
}

export interface RuntimeHostStatus extends RuntimeHello {
  mode: 'in-process' | 'daemon'
  connection: 'spawning' | 'handshaking' | 'connected' | 'degraded'
  sessionCount: number
  pid?: number
  startedAt?: string
  fallbackReason?: string
}

export type HostEvent =
  | { kind: 'pty-data'; sessionId: string; bytes: string }
  | {
      kind: 'state'
      sessionId: string
      state: TerminalRunState
      prevStatus: TerminalRunStatus
    }
  | { kind: 'exit'; sessionId: string; code: number }
  | {
      kind: 'agent-event'
      sessionId: string
      event: AgentEvent
      turnId?: string
      seq?: number
      timelineItem?: ManagedChatTimelineItem
    }
  | { kind: 'task-changed'; event: TaskChangedEvent }

export interface RuntimeSessionHandle {
  session: WorkbenchSession
  terminal: TerminalSessionInfo | null
}

export interface RuntimeHost {
  hello(): Promise<RuntimeHello>
  hostStatus(): Promise<RuntimeHostStatus>
  listRuntimes(): Promise<RuntimeInfo[]>
  /** 某工具可选的模型列表（本机=本地发现；远程节点=节点上报，见 SPEC-033）。
   *  hostId 仅联邦层用于路由到指定主机；单主机实现忽略它、恒返回自身模型。 */
  listModels(toolId: string, hostId?: string): Promise<ToolModelCatalog>
  /** 浏览目标 runtime 主机上的目录，供远程 agent 选择真实工作目录。 */
  listDirectories(input?: ListRuntimeDirectoriesInput): Promise<RuntimeDirectoryListing>
  listSessions(): Promise<WorkbenchSession[]>
  listSessionViews(): Promise<WorkbenchSessionView[]>
  createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle>
  resumeSession(id: string): Promise<RuntimeSessionHandle>
  openLinkedTerminal(id: string): Promise<RuntimeSessionHandle>
  updateSession(id: string, patch: UpdateSessionPatch): Promise<WorkbenchSession | null>
  removeSession(id: string): Promise<void>
  write(sessionId: string, data: string): Promise<boolean>
  resize(sessionId: string, cols: number, rows: number): Promise<boolean>
  history(sessionId: string): Promise<string>
  state(sessionId: string): Promise<TerminalRunState | null>
  states(): Promise<TerminalRunState[]>
  kill(sessionId: string): Promise<boolean>
  sendTurn(sessionId: string, text: string, files?: string[], contextPack?: TurnContextPack): Promise<ChatTurnState>
  steerTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState>
  queueTurn(sessionId: string, text: string, files?: string[], contextPack?: TurnContextPack): Promise<ManagedQueuedTurn>
  listQueuedTurns(sessionId: string): Promise<ManagedQueuedTurn[]>
  cancelQueuedTurn(sessionId: string, queuedTurnId: string): Promise<boolean>
  interruptTurn(sessionId: string): Promise<boolean>
  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<ChatTurnState>
  chatState(sessionId: string): Promise<ChatTurnState>
  chatHistory(sessionId: string): Promise<ManagedChatMessage[]>
  chatTimeline(sessionId: string): Promise<ManagedChatTimelineItem[]>
  listTasks(): Promise<AgentTask[]>
  listTaskRuns(taskId: string): Promise<TaskRun[]>
  createTask(input: CreateTaskInput): Promise<AgentTask>
  updateTask(id: string, patch: UpdateTaskPatch): Promise<AgentTask | null>
  removeTask(id: string): Promise<void>
  runTaskNow(id: string): Promise<TaskRun>
  attach(sessionId: string): AsyncIterable<HostEvent>
  subscribe(listener: (event: HostEvent) => void): () => void
}
