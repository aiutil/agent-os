import type { AgentTask, TaskExecutionStatus } from './types'
import type { Lang } from './i18n'

export type TaskPresentationState = TaskExecutionStatus | 'confirmed' | 'cancelled'

export interface TaskStatusPresentation {
  label: string
  state: TaskPresentationState
}

const ACTIVE_EXECUTION_LABELS_ZH: Record<TaskExecutionStatus, string> = {
  idle: '准备执行',
  queued: '排队中',
  running: '执行中',
  needs_attention: '需要处理',
  succeeded: '进行中 · 上次执行成功',
  failed: '进行中 · 上次执行失败',
  interrupted: '进行中 · 上次执行中断'
}

const REVIEW_EXECUTION_LABELS_ZH: Record<TaskExecutionStatus, string> = {
  idle: '待审阅',
  queued: '待审阅 · 最近执行排队中',
  running: '待审阅 · 最近执行中',
  needs_attention: '需要处理',
  succeeded: '执行成功 · 待确认',
  failed: '执行失败 · 待处理',
  interrupted: '已中断 · 待处理'
}

const ACTIVE_EXECUTION_LABELS_EN: Record<TaskExecutionStatus, string> = {
  idle: 'Ready', queued: 'Queued', running: 'Running', needs_attention: 'Needs attention',
  succeeded: 'In progress · Last run succeeded', failed: 'In progress · Last run failed',
  interrupted: 'In progress · Last run interrupted'
}

const REVIEW_EXECUTION_LABELS_EN: Record<TaskExecutionStatus, string> = {
  idle: 'In review', queued: 'In review · Latest run queued', running: 'In review · Latest run active',
  needs_attention: 'Needs attention', succeeded: 'Succeeded · Awaiting confirmation',
  failed: 'Failed · Needs review', interrupted: 'Interrupted · Needs review'
}

/**
 * Projects the task workflow state and latest execution state into one UI status.
 * Board state is authoritative for the task; run history renders TaskRun.status separately.
 */
export function presentTaskStatus(
  task: Pick<AgentTask, 'boardStatus' | 'executionStatus'>,
  lang: Lang = 'zh'
): TaskStatusPresentation {
  const activeLabels = lang === 'zh' ? ACTIVE_EXECUTION_LABELS_ZH : ACTIVE_EXECUTION_LABELS_EN
  const reviewLabels = lang === 'zh' ? REVIEW_EXECUTION_LABELS_ZH : REVIEW_EXECUTION_LABELS_EN
  switch (task.boardStatus) {
    case 'backlog':
      return { label: lang === 'zh' ? '待规划' : 'Planning', state: 'idle' }
    case 'todo':
      return { label: lang === 'zh' ? '待执行' : 'Ready', state: 'idle' }
    case 'in_progress':
      return {
        label: activeLabels[task.executionStatus],
        state: task.executionStatus === 'idle' ? 'queued' : task.executionStatus
      }
    case 'review':
      return {
        label: reviewLabels[task.executionStatus],
        state:
          task.executionStatus === 'idle' || task.executionStatus === 'queued'
            ? 'needs_attention'
            : task.executionStatus
      }
    case 'done':
      return { label: lang === 'zh' ? '已确认完成' : 'Confirmed complete', state: 'confirmed' }
    case 'cancelled':
      return { label: lang === 'zh' ? '已取消' : 'Cancelled', state: 'cancelled' }
  }
}
