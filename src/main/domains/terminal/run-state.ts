// 终端运行状态机（SPEC-004）。
// 纯函数 / 纯类，无 electron / node-pty 依赖，便于单测。
// 重写自 v1 electron/terminal-run-state.cjs，时间通过注入便于测试。

import type {
  TerminalBackend,
  TerminalRunState,
  TerminalRunStatus
} from '@shared/types'

export const OUTPUT_TAIL_LINES = 12
export const IDLE_THRESHOLD_MS = 8000

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\x1b\][^\x07]*(\x07|\x1b\\)/g

/** 去除 ANSI 转义，归一换行，仅保留最后 N 行可读文本。 */
export function sanitizeTail(buffer: string): string {
  return String(buffer || '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-OUTPUT_TAIL_LINES)
    .join('\n')
}

/** 把新数据并入既有尾巴。 */
export function appendOutputTail(prevTail: string, rawData: string): string {
  const cleaned = String(rawData || '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(/\r/g, '\n')
  return sanitizeTail(`${prevTail || ''}\n${cleaned}`)
}

const TERMINAL_DONE: TerminalRunStatus[] = ['completed', 'failed', 'disconnected']

export interface CreateStateInput {
  sessionId: string
  toolId?: string
  workspacePath?: string
  command?: string
  backend?: TerminalBackend
}

export interface RunStateMachineOptions {
  now?: () => string
  clock?: () => number
  idleThresholdMs?: number
}

/**
 * 状态迁移：
 *   starting --data--> running --idle--> waiting_input --data--> running
 *   running  --exit(0)--> completed
 *   running  --exit(≠0)--> failed
 *   *        --close--> disconnected
 */
export class TerminalRunStateMachine {
  private readonly states = new Map<string, TerminalRunState>()
  private readonly now: () => string
  private readonly clock: () => number
  readonly idleThresholdMs: number

  constructor(options: RunStateMachineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.clock = options.clock ?? (() => Date.now())
    this.idleThresholdMs = options.idleThresholdMs ?? IDLE_THRESHOLD_MS
  }

  createState(input: CreateStateInput): TerminalRunState {
    if (!input.sessionId) throw new Error('sessionId is required')
    const now = this.now()
    const state: TerminalRunState = {
      sessionId: input.sessionId,
      toolId: input.toolId ?? '',
      workspacePath: input.workspacePath ?? '',
      command: input.command ?? '',
      status: 'starting',
      backend: input.backend ?? 'pty',
      startedAt: now,
      lastActivityAt: now,
      exitCode: null,
      outputTail: ''
    }
    this.states.set(input.sessionId, state)
    return state
  }

  feedData(sessionId: string, data: string): TerminalRunState | null {
    const state = this.states.get(sessionId)
    if (!state) return null
    if (TERMINAL_DONE.includes(state.status)) return state
    state.outputTail = appendOutputTail(state.outputTail, data)
    state.lastActivityAt = this.now()
    if (state.status === 'starting' || state.status === 'waiting_input') {
      state.status = 'running'
    }
    return state
  }

  feedExit(sessionId: string, exitCode: number): TerminalRunState | null {
    const state = this.states.get(sessionId)
    if (!state) return null
    if (state.status === 'completed' || state.status === 'failed') return state
    state.status = exitCode === 0 ? 'completed' : 'failed'
    state.exitCode = Number.isFinite(exitCode) ? exitCode : null
    state.lastActivityAt = this.now()
    return state
  }

  feedIdle(sessionId: string): TerminalRunState | null {
    const state = this.states.get(sessionId)
    if (!state) return null
    if (state.status !== 'running') return state
    const last = new Date(state.lastActivityAt).getTime()
    if (!Number.isFinite(last)) return state
    if (this.clock() - last >= this.idleThresholdMs) {
      state.status = 'waiting_input'
    }
    return state
  }

  feedDisconnected(sessionId: string): TerminalRunState | null {
    const state = this.states.get(sessionId)
    if (!state) return null
    state.status = 'disconnected'
    state.lastActivityAt = this.now()
    return state
  }

  getState(sessionId: string): TerminalRunState | null {
    return this.states.get(sessionId) ?? null
  }

  listStates(): TerminalRunState[] {
    return Array.from(this.states.values())
  }

  removeState(sessionId: string): boolean {
    return this.states.delete(sessionId)
  }
}
