import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type {
  AgentTask,
  CreateTaskInput,
  HostEvent,
  RuntimeHost,
  TaskChangedEvent,
  TaskRun,
  UpdateTaskPatch
} from '@shared/types'
import { advanceSchedule } from './cron'
import { TaskRepository } from './repository'
import {
  isTaskRunActive,
  taskForNeedsAttention,
  taskForRunFinished,
  taskForRunQueued,
  taskForRunStarted
} from './state'

const DEFAULT_TICK_MS = 15_000
const MISFIRE_GRACE_MS = 60_000

export interface TaskServiceOptions {
  repository: TaskRepository
  runtime(): RuntimeHost
  emit(event: TaskChangedEvent): void
  now?: () => Date
  tickMs?: number
  workspaceExists?: (path: string) => boolean
}

function requireText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label}不能为空`)
  return normalized
}

export class TaskService {
  private readonly now: () => Date
  private readonly workspaceExists: (path: string) => boolean
  private readonly runBySession = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private ticking = false

  constructor(private readonly options: TaskServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.workspaceExists = options.workspaceExists ?? existsSync
  }

  start(): void {
    if (this.timer) return
    this.options.repository.markInterrupted(this.now())
    this.unsubscribe = this.options.runtime().subscribe((event) => this.onHostEvent(event))
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? DEFAULT_TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  listTasks(): AgentTask[] {
    return this.options.repository.listTasks()
  }

  listTaskRuns(taskId: string): TaskRun[] {
    return this.options.repository.listRuns(taskId)
  }

  createTask(input: CreateTaskInput): AgentTask {
    this.validateInput(input)
    const task = this.options.repository.createTask(input, this.now())
    this.options.emit({ task, reason: 'created' })
    return task
  }

  updateTask(id: string, patch: UpdateTaskPatch): AgentTask | null {
    if (patch.title !== undefined) requireText(patch.title, '任务标题')
    if (patch.prompt !== undefined) requireText(patch.prompt, '任务说明')
    if (patch.workspacePath !== undefined) requireText(patch.workspacePath, '工作目录')
    if (patch.assignee !== undefined) requireText(patch.assignee.toolId, '执行 Agent')
    const updated = this.options.repository.updateTask(id, patch, this.now())
    if (updated) this.options.emit({ task: updated, reason: 'updated' })
    return updated
  }

  removeTask(id: string): void {
    const task = this.options.repository.getTask(id)
    if (!task) return
    const active = this.options.repository.listRuns(id).some(isTaskRunActive)
    if (active) throw new Error('任务正在执行，不能删除')
    this.options.repository.removeTask(id)
    this.options.emit({ task, reason: 'removed' })
  }

  runTaskNow(id: string): TaskRun {
    const task = this.options.repository.getTask(id)
    if (!task) throw new Error('任务不存在')
    return this.queueRun(task, 'manual')
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      for (const task of this.options.repository.listTasks()) {
        const schedule = task.schedule
        if (!schedule?.enabled || !schedule.nextRunAt) continue
        const scheduledFor = new Date(schedule.nextRunAt)
        if (!Number.isFinite(scheduledFor.getTime()) || scheduledFor.getTime() > now.getTime())
          continue

        let nextSchedule = advanceSchedule(schedule, scheduledFor)
        while (
          nextSchedule.enabled &&
          nextSchedule.nextRunAt &&
          new Date(nextSchedule.nextRunAt).getTime() <= now.getTime()
        ) {
          nextSchedule = advanceSchedule(nextSchedule, new Date(nextSchedule.nextRunAt))
        }
        const advanced = this.options.repository.replaceTask({
          ...task,
          schedule: nextSchedule,
          updatedAt: now.toISOString()
        })
        this.options.emit({ task: advanced, reason: 'schedule-advanced' })

        if (
          schedule.misfirePolicy === 'skip' &&
          now.getTime() - scheduledFor.getTime() > MISFIRE_GRACE_MS
        ) {
          this.skipRun(advanced, scheduledFor.toISOString(), '错过计划时间，已按策略跳过')
          continue
        }
        this.queueRun(advanced, 'schedule', scheduledFor.toISOString())
      }
    } finally {
      this.ticking = false
    }
  }

  private validateInput(input: CreateTaskInput): void {
    if (
      input.portableId !== undefined &&
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(input.portableId)
    ) {
      throw new Error('迁移任务 ID 无效')
    }
    requireText(input.title, '任务标题')
    requireText(input.prompt, '任务说明')
    requireText(input.workspacePath, '工作目录')
    requireText(input.assignee.toolId, '执行 Agent')
  }

  private queueRun(task: AgentTask, trigger: TaskRun['trigger'], scheduledFor?: string): TaskRun {
    const taskActive = this.options.repository.listRuns(task.id).some(isTaskRunActive)
    const workspaceActive = this.options.repository
      .listTasks()
      .some(
        (other) =>
          other.id !== task.id &&
          other.workspacePath === task.workspacePath &&
          ['queued', 'running', 'needs_attention'].includes(other.executionStatus)
      )
    if (taskActive || workspaceActive) {
      if (trigger === 'schedule') {
        return this.skipRun(
          task,
          scheduledFor,
          taskActive ? '任务仍在执行' : '同一工作目录已有任务执行'
        )
      }
      throw new Error(taskActive ? '任务正在执行' : '同一工作目录已有任务执行')
    }

    const run: TaskRun = {
      id: randomUUID(),
      taskId: task.id,
      trigger,
      status: 'queued',
      ...(scheduledFor ? { scheduledFor } : {})
    }
    this.options.repository.appendRun(run)
    const updated = this.options.repository.replaceTask(
      taskForRunQueued(task, run, this.now().toISOString())
    )
    this.options.emit({ task: updated, run, reason: 'run-queued' })
    void this.execute(updated, run)
    return run
  }

  private skipRun(task: AgentTask, scheduledFor: string | undefined, error: string): TaskRun {
    const now = this.now().toISOString()
    const run: TaskRun = {
      id: randomUUID(),
      taskId: task.id,
      trigger: 'schedule',
      status: 'skipped',
      ...(scheduledFor ? { scheduledFor } : {}),
      finishedAt: now,
      error
    }
    this.options.repository.appendRun(run)
    this.options.emit({ task, run, reason: 'run-skipped' })
    return run
  }

  private async execute(task: AgentTask, queued: TaskRun): Promise<void> {
    try {
      if (!this.workspaceExists(task.workspacePath)) throw new Error('任务工作目录不存在')
      const runtime = this.options.runtime()
      const assigned = (await runtime.listRuntimes()).find(
        (item) => item.toolId === task.assignee.toolId
      )
      if (
        !assigned ||
        !assigned.capabilities.chat ||
        !['ready', 'updatable'].includes(assigned.health)
      ) {
        throw new Error(`执行 Agent 不可用：${task.assignee.toolId}`)
      }

      let sessionId: string | undefined
      if (task.sessionPolicy === 'continue_last' && task.latestSessionId) {
        const existing = (await runtime.listSessions()).find(
          (session) =>
            session.id === task.latestSessionId &&
            session.toolId === task.assignee.toolId &&
            session.workspacePath === task.workspacePath &&
            session.surface === 'chat'
        )
        if (existing) {
          const state = await runtime.chatState(existing.id)
          if (state.status !== 'running' && state.status !== 'awaiting-permission') {
            sessionId = existing.id
          }
        }
      }
      if (!sessionId) {
        const created = await runtime.createSession({
          name: task.title,
          nameProvisional: false,
          toolId: task.assignee.toolId,
          workspacePath: task.workspacePath,
          surface: 'chat',
          permissionPreset: task.permissionPreset,
          ...(task.assignee.model ? { model: task.assignee.model } : {}),
          source: 'task'
        })
        sessionId = created.session.id
      }

      const now = this.now().toISOString()
      const running: TaskRun = { ...queued, status: 'running', sessionId, startedAt: now }
      this.options.repository.replaceRun(running)
      this.runBySession.set(sessionId, running.id)
      const current = this.options.repository.getTask(task.id)
      if (!current) throw new Error('任务已被删除')
      const updated = this.options.repository.replaceTask(taskForRunStarted(current, running, now))
      this.options.emit({ task: updated, run: running, reason: 'run-started' })
      await runtime.sendTurn(sessionId, task.prompt)
    } catch (error) {
      this.finishRun(queued.id, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  private onHostEvent(event: HostEvent): void {
    if (event.kind !== 'agent-event') return
    const runId = this.runBySession.get(event.sessionId)
    if (!runId) return
    if (event.event.kind === 'permission-request') {
      const located = this.findRun(runId)
      if (!located) return
      const now = this.now().toISOString()
      const run: TaskRun = { ...located.run, status: 'needs_attention' }
      this.options.repository.replaceRun(run)
      const task = this.options.repository.replaceTask(taskForNeedsAttention(located.task, now))
      this.options.emit({ task, run, reason: 'needs-attention' })
      return
    }
    if (event.event.kind === 'turn-end') {
      this.finishRun(
        runId,
        event.event.status === 'completed' ? 'succeeded' : 'interrupted',
        event.event.status === 'interrupted' ? '执行被中断' : undefined
      )
      return
    }
    if (event.event.kind === 'error' && event.event.retryable !== true) {
      this.finishRun(runId, 'failed', event.event.message)
    }
  }

  private findRun(runId: string): { task: AgentTask; run: TaskRun } | null {
    for (const task of this.options.repository.listTasks()) {
      const run = this.options.repository.listRuns(task.id).find((item) => item.id === runId)
      if (run) return { task, run }
    }
    return null
  }

  private finishRun(
    runId: string,
    status: Extract<TaskRun['status'], 'succeeded' | 'failed' | 'interrupted'>,
    error?: string
  ): void {
    const located = this.findRun(runId)
    if (!located || !isTaskRunActive(located.run)) return
    const now = this.now().toISOString()
    const run: TaskRun = {
      ...located.run,
      status,
      finishedAt: now,
      ...(error ? { error } : {})
    }
    this.options.repository.replaceRun(run)
    if (run.sessionId) this.runBySession.delete(run.sessionId)
    const task = this.options.repository.replaceTask(
      taskForRunFinished(located.task, status, now, error)
    )
    this.options.emit({ task, run, reason: 'run-finished' })
  }
}
