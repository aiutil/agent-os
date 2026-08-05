import type { TurnContextPack } from './types/memory'

const TASK_OPEN = '<agent-os-task version="1">'
const TASK_CLOSE = '</agent-os-task>'
const CONTEXT_OPEN = '<agent-os-context version="1">'
const CONTEXT_CLOSE = '</agent-os-context>'

/**
 * 未提供独立 system/developer 通道的 CLI 使用这份安全信封。
 * 任务必须位于最前：原生工具从 stdin 的首段取标题时不会再把记忆当标题。
 */
export function serializeTurnWithContext(task: string, pack?: TurnContextPack): string {
  const cleanTask = task.trim()
  const context = pack?.text.trim() ?? ''
  if (!context) return cleanTask
  return [TASK_OPEN, cleanTask, TASK_CLOSE, '', CONTEXT_OPEN, context, CONTEXT_CLOSE].join('\n')
}

/** 标题/转录层从 Agent OS 任务信封恢复真实用户任务。 */
export function extractAgentOsTask(value: string): string | null {
  const start = value.indexOf(TASK_OPEN)
  if (start < 0) return null
  const contentStart = start + TASK_OPEN.length
  const end = value.indexOf(TASK_CLOSE, contentStart)
  if (end < 0) return null
  const task = value.slice(contentStart, end).trim()
  return task || null
}

/** 从转录/标题候选中移除 Agent OS 上下文，保留任务及普通人类文本。 */
export function stripAgentOsContext(value: string): string {
  const task = extractAgentOsTask(value)
  if (task) return task
  const start = value.indexOf(CONTEXT_OPEN)
  if (start < 0) return value
  const end = value.indexOf(CONTEXT_CLOSE, start + CONTEXT_OPEN.length)
  return `${value.slice(0, start)}${end < 0 ? '' : value.slice(end + CONTEXT_CLOSE.length)}`.trim()
}
