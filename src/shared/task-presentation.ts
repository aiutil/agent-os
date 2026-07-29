import type { AgentTask, TaskExecutionStatus } from './types'

export type TaskPresentationState = TaskExecutionStatus | 'confirmed' | 'cancelled'

export interface TaskStatusPresentation {
  label: string
  state: TaskPresentationState
}

const ACTIVE_EXECUTION_LABELS: Record<TaskExecutionStatus, string> = {
  idle: '准备执行',
  queued: '排队中',
  running: '执行中',
  needs_attention: '需要处理',
  succeeded: '进行中 · 上次执行成功',
  failed: '进行中 · 上次执行失败',
  interrupted: '进行中 · 上次执行中断'
}

const REVIEW_EXECUTION_LABELS: Record<TaskExecutionStatus, string> = {
  idle: '待审阅',
  queued: '待审阅 · 最近执行排队中',
  running: '待审阅 · 最近执行中',
  needs_attention: '需要处理',
  succeeded: '执行成功 · 待确认',
  failed: '执行失败 · 待处理',
  interrupted: '已中断 · 待处理'
}

/**
 * Projects the task workflow state and latest execution state into one UI status.
 * Board state is authoritative for the task; run history renders TaskRun.status separately.
 */
export function presentTaskStatus(
  task: Pick<AgentTask, 'boardStatus' | 'executionStatus'>
): TaskStatusPresentation {
  switch (task.boardStatus) {
    case 'backlog':
      return { label: '待规划', state: 'idle' }
    case 'todo':
      return { label: '待执行', state: 'idle' }
    case 'in_progress':
      return {
        label: ACTIVE_EXECUTION_LABELS[task.executionStatus],
        state: task.executionStatus === 'idle' ? 'queued' : task.executionStatus
      }
    case 'review':
      return {
        label: REVIEW_EXECUTION_LABELS[task.executionStatus],
        state:
          task.executionStatus === 'idle' || task.executionStatus === 'queued'
            ? 'needs_attention'
            : task.executionStatus
      }
    case 'done':
      return { label: '已确认完成', state: 'confirmed' }
    case 'cancelled':
      return { label: '已取消', state: 'cancelled' }
  }
}
