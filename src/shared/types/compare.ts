// 对比工作台类型（SPEC-009）。

import type { TerminalRunStatus } from './terminal'

export type CompareScenarioPaneType = 'cli' | 'chat' | 'webchat'

/** V3 轻量广播对比方案中的单个分栏。 */
export interface CompareScenarioPane {
  id: string
  type: CompareScenarioPaneType
  toolId?: string
  webService?: string
  sessionId?: string | null
  lastUrl?: string | null
}

/** V3 轻量广播对比方案，独立于 git worktree CompareRun。 */
export interface CompareScenario {
  id: string
  title: string
  workspacePath: string
  prompt: string
  paneCount: number
  panes: CompareScenarioPane[]
  createdAt: string
  updatedAt: string
}

export interface SaveCompareScenarioInput {
  id?: string
  title?: string
  workspacePath: string
  prompt: string
  paneCount: number
  panes: CompareScenarioPane[]
}

/** 对比运行中的单列（每列对应一个 CLI + worktree）。 */
export interface CompareColumn {
  toolId: string
  sessionId: string
  worktreePath: string
  branch: string
  startedAt: string
  endedAt?: string
  adopted?: boolean
}

/** 一次多 CLI 对比运行。 */
export interface CompareRun {
  id: string
  workspacePath: string
  prompt: string
  columns: CompareColumn[]
  status: 'preparing' | 'running' | 'reviewing' | 'adopted' | 'discarded'
  createdAt: string
  updatedAt: string
}

/** compare:start 入参。 */
export interface CompareStartInput {
  workspacePath: string
  prompt: string
  toolIds: string[]
}

/** compare:adopt 响应。 */
export interface CompareAdoptResult {
  merged: boolean
  conflict?: string
}

/** 列视图：CompareColumn + 实时终端状态。 */
export interface CompareColumnView extends CompareColumn {
  status: TerminalRunStatus | 'preparing'
  outputTail: string
  elapsedMs?: number
}

/** 对比运行视图：附带列实时状态。 */
export interface CompareRunView extends Omit<CompareRun, 'columns'> {
  columns: CompareColumnView[]
}
