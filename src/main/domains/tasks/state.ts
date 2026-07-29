import type {
  AgentTask,
  TaskBoardStatus,
  TaskExecutionStatus,
  TaskRun,
  TaskRunStatus
} from '@shared/types'

const ACTIVE_RUNS = new Set<TaskRunStatus>(['queued', 'running', 'needs_attention'])

export function isTaskRunActive(run: TaskRun): boolean {
  return ACTIVE_RUNS.has(run.status)
}

export function canMoveTask(task: AgentTask, status: TaskBoardStatus): boolean {
  if (
    task.executionStatus === 'queued' ||
    task.executionStatus === 'running' ||
    task.executionStatus === 'needs_attention'
  ) {
    return status === 'in_progress'
  }
  return true
}

export function taskForRunQueued(task: AgentTask, run: TaskRun, now: string): AgentTask {
  return {
    ...task,
    boardStatus: 'in_progress',
    executionStatus: 'queued',
    latestRunId: run.id,
    lastError: undefined,
    updatedAt: now
  }
}

export function taskForRunStarted(task: AgentTask, run: TaskRun, now: string): AgentTask {
  return {
    ...task,
    boardStatus: 'in_progress',
    executionStatus: 'running',
    latestRunId: run.id,
    ...(run.sessionId ? { latestSessionId: run.sessionId } : {}),
    lastError: undefined,
    updatedAt: now
  }
}

export function taskForNeedsAttention(task: AgentTask, now: string): AgentTask {
  return { ...task, boardStatus: 'in_progress', executionStatus: 'needs_attention', updatedAt: now }
}

export function taskForRunFinished(
  task: AgentTask,
  status: Extract<TaskExecutionStatus, 'succeeded' | 'failed' | 'interrupted'>,
  now: string,
  error?: string
): AgentTask {
  return {
    ...task,
    boardStatus: 'review',
    executionStatus: status,
    ...(error ? { lastError: error } : { lastError: undefined }),
    updatedAt: now
  }
}
