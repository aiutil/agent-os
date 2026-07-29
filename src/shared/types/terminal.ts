// 终端会话状态领域模型（SPEC-004）。
// 重写自 v1 electron/terminal-run-state.cjs 的纯状态机模型。

/**
 * 终端运行状态。映射 v2 设计的会话卡状态色：
 * - running        工作中（绿，呼吸）
 * - waiting_input  等待输入（琥珀，呼吸）
 * - starting       启动中（视作工作中）
 * - completed      正常退出（断开/灰）
 * - failed         异常退出（危险/红）
 * - disconnected   PTY 已断开（暖灰）
 */
export type TerminalRunStatus =
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'disconnected'

/** PTY 后端实现。 */
export type TerminalBackend = 'pty' | 'shell-pty'

/** 结构化终端运行状态（薄状态层，终端本体仍是事实来源）。 */
export interface TerminalRunState {
  sessionId: string
  toolId: string
  workspacePath: string
  command: string
  status: TerminalRunStatus
  backend: TerminalBackend
  startedAt: string
  lastActivityAt: string
  exitCode: number | null
  /** 去 ANSI 后的输出尾巴（最近若干行），供 Rail 卡片/对话预览使用。 */
  outputTail: string
}

/** 启动 PTY 的入参。 */
export interface LaunchTerminalInput {
  toolId: string
  cwd: string
  /** 要执行的命令；为空则进入交互式 shell。 */
  command: string
  /** 仅注入当前 CLI 子进程，不写入用户 shell 配置。 */
  env?: Record<string, string>
}

/** 启动成功后返回的会话句柄。 */
export interface TerminalSessionInfo {
  sessionId: string
  toolId: string
  cwd: string
  command: string
  backend: TerminalBackend
  createdAt: string
}

/** 主进程 → 渲染端事件载荷。 */
export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
}

export interface TerminalStateChangedEvent {
  sessionId: string
  state: TerminalRunState
  prevStatus: TerminalRunStatus
}
