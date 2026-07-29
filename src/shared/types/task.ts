import type { PermissionPreset } from './agent-event'

export type TaskBoardStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'cancelled'

export type TaskExecutionStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'needs_attention'
  | 'succeeded'
  | 'failed'
  | 'interrupted'

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'needs_attention'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'skipped'

export interface TaskAssignee {
  toolId: string
  model?: string
}

interface TaskScheduleBase {
  timeZone: string
  enabled: boolean
  misfirePolicy: 'run_once' | 'skip'
  nextRunAt?: string
}

export type TaskSchedule =
  | (TaskScheduleBase & {
      kind: 'once'
      runAt: string
    })
  | (TaskScheduleBase & {
      kind: 'cron'
      /** 标准五段 cron：minute hour day-of-month month day-of-week。 */
      expression: string
    })
  | (TaskScheduleBase & {
      kind: 'interval'
      /** 固定间隔毫秒数；合法范围由调度域校验。 */
      everyMs: number
      /** 间隔相位基点。nextRunAt 始终是严格晚于推进基准的首个相位点。 */
      anchorAt: string
    })

export interface AgentTask {
  id: string
  title: string
  prompt: string
  workspacePath: string
  /** 联邦聚合时盖戳；目标主机本地文件不依赖此字段。 */
  runtimeHostId?: string
  assignee: TaskAssignee
  boardStatus: TaskBoardStatus
  executionStatus: TaskExecutionStatus
  permissionPreset: PermissionPreset
  sessionPolicy: 'new' | 'continue_last'
  schedule?: TaskSchedule
  latestRunId?: string
  latestSessionId?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface TaskRun {
  id: string
  taskId: string
  trigger: 'manual' | 'schedule'
  status: TaskRunStatus
  sessionId?: string
  scheduledFor?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

export interface CreateTaskInput {
  /** 仅安全迁移服务使用；保持重复导入幂等。普通创建省略并由仓储生成 UUID。 */
  portableId?: string
  title: string
  prompt: string
  workspacePath: string
  /** 仅联邦层消费；目标主机仓储不持久化该值。 */
  runtimeHostId?: string
  assignee: TaskAssignee
  boardStatus?: Extract<TaskBoardStatus, 'backlog' | 'todo'>
  permissionPreset?: PermissionPreset
  sessionPolicy?: 'new' | 'continue_last'
  schedule?: TaskSchedule
  /** 仅供本机匿名产品分析归因，不持久化到任务，也不随事件发送正文。 */
  creationSource?: 'manual' | 'semantic'
}

export interface UpdateTaskPatch {
  title?: string
  prompt?: string
  workspacePath?: string
  assignee?: TaskAssignee
  boardStatus?: TaskBoardStatus
  permissionPreset?: PermissionPreset
  sessionPolicy?: 'new' | 'continue_last'
  schedule?: TaskSchedule | null
}

export interface TaskFileV1 {
  schemaVersion: 1
  tasks: AgentTask[]
  runs: TaskRun[]
}

export type TaskChangeReason =
  | 'created'
  | 'updated'
  | 'removed'
  | 'run-queued'
  | 'run-started'
  | 'needs-attention'
  | 'run-finished'
  | 'run-skipped'
  | 'schedule-advanced'

export interface TaskChangedEvent {
  task: AgentTask
  run?: TaskRun
  reason: TaskChangeReason
}
