export type PermissionDecision = 'once' | 'always' | 'deny'
export type PermissionPreset = 'safe' | 'acceptEdits' | 'auto'
export type ChatTurnStatus = 'idle' | 'running' | 'awaiting-permission' | 'failed' | 'interrupted'

export type AgentEvent =
  | { kind: 'session-bound'; nativeSessionId: string; model?: string }
  | { kind: 'text-delta'; text: string }
  | { kind: 'thinking-delta'; text: string }
  | { kind: 'tool-start'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool-result'; toolUseId: string; content: string; isError: boolean }
  | {
      kind: 'permission-request'
      requestId: string
      toolName: string
      input: unknown
      suggestions: unknown[]
    }
  | {
      kind: 'turn-end'
      status: 'completed' | 'interrupted'
      costUsd?: number
    }
  | { kind: 'error'; message: string; retryable?: boolean }
  | { kind: 'unknown'; rawType: string; payload: unknown }

/**
 * 一条历史回合消息。供无原生会话记忆的适配器（codex/opencode/cursor-agent）
 * 把先前对话重组进 prompt，从而实现多回合连续（SPEC-019）。
 */
export interface ChatTurnMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface ChatTurnState {
  sessionId: string
  /** 稳定的逻辑回合 id；审批导致子进程重启时不变，终态后为 null。 */
  turnId?: string | null
  status: ChatTurnStatus
  startedAt: string | null
  updatedAt: string
  pendingPermission: Extract<AgentEvent, { kind: 'permission-request' }> | null
  error: string | null
  queuedCount: number
  /** SPEC-040：本次用户消息触发的语义定时自动化结果。 */
  taskAutomation?:
    | { status: 'created'; taskId: string; title: string; nextRunAt?: string }
    | { status: 'failed'; error: string }
}

export interface AgentEventEnvelope {
  sessionId: string
  event: AgentEvent
  turnId?: string
  seq?: number
  timelineItem?: import('./session').ManagedChatTimelineItem
}
