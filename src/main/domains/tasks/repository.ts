import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AgentTask,
  CreateTaskInput,
  TaskFileV1,
  TaskRun,
  UpdateTaskPatch
} from '@shared/types'
import { normalizeSchedule } from './cron'
import { canMoveTask } from './state'

const SCHEMA_VERSION = 1 as const
const MAX_RUNS_PER_TASK = 50

export class TaskStoreCorruptError extends Error {
  constructor(readonly filePath: string) {
    super(`任务仓储无法解析：${filePath}`)
    this.name = 'TaskStoreCorruptError'
  }
}

export class TaskRepository {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    if (!existsSync(filePath)) this.write({ schemaVersion: SCHEMA_VERSION, tasks: [], runs: [] })
  }

  listTasks(): AgentTask[] {
    return this.read().tasks
  }

  getTask(id: string): AgentTask | null {
    return this.listTasks().find((task) => task.id === id) ?? null
  }

  listRuns(taskId: string): TaskRun[] {
    return this.read()
      .runs.filter((run) => run.taskId === taskId)
      .sort((a, b) =>
        (b.startedAt ?? b.scheduledFor ?? '').localeCompare(a.startedAt ?? a.scheduledFor ?? '')
      )
  }

  createTask(input: CreateTaskInput, now = new Date()): AgentTask {
    const data = this.read()
    const id = input.portableId?.trim() || randomUUID()
    if (data.tasks.some((task) => task.id === id)) throw new Error('任务 ID 已存在')
    const iso = now.toISOString()
    const task: AgentTask = {
      id,
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      workspacePath: input.workspacePath.trim(),
      assignee: {
        toolId: input.assignee.toolId,
        ...(input.assignee.model ? { model: input.assignee.model } : {})
      },
      boardStatus: input.boardStatus ?? 'todo',
      executionStatus: 'idle',
      permissionPreset: input.permissionPreset ?? 'safe',
      sessionPolicy: input.sessionPolicy ?? 'new',
      ...(input.schedule ? { schedule: normalizeSchedule(input.schedule, now) } : {}),
      createdAt: iso,
      updatedAt: iso
    }
    this.write({ ...data, tasks: [task, ...data.tasks] })
    return task
  }

  updateTask(id: string, patch: UpdateTaskPatch, now = new Date()): AgentTask | null {
    const data = this.read()
    const index = data.tasks.findIndex((task) => task.id === id)
    if (index < 0) return null
    const current = data.tasks[index]
    if (patch.boardStatus && !canMoveTask(current, patch.boardStatus)) {
      throw new Error('运行中的任务不能移动到其他状态')
    }
    const updated: AgentTask = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
      ...(patch.workspacePath !== undefined ? { workspacePath: patch.workspacePath.trim() } : {}),
      ...(patch.assignee !== undefined
        ? {
            assignee: {
              toolId: patch.assignee.toolId,
              ...(patch.assignee.model ? { model: patch.assignee.model } : {})
            }
          }
        : {}),
      ...(patch.boardStatus !== undefined ? { boardStatus: patch.boardStatus } : {}),
      ...(patch.permissionPreset !== undefined ? { permissionPreset: patch.permissionPreset } : {}),
      ...(patch.sessionPolicy !== undefined ? { sessionPolicy: patch.sessionPolicy } : {}),
      ...(patch.schedule === null
        ? { schedule: undefined }
        : patch.schedule !== undefined
          ? { schedule: normalizeSchedule(patch.schedule, now) }
          : {}),
      updatedAt: now.toISOString()
    }
    data.tasks[index] = updated
    this.write(data)
    return updated
  }

  replaceTask(task: AgentTask): AgentTask {
    const data = this.read()
    const index = data.tasks.findIndex((item) => item.id === task.id)
    if (index < 0) throw new Error('任务不存在')
    data.tasks[index] = task
    this.write(data)
    return task
  }

  removeTask(id: string): void {
    const data = this.read()
    this.write({
      ...data,
      tasks: data.tasks.filter((task) => task.id !== id),
      runs: data.runs.filter((run) => run.taskId !== id)
    })
  }

  appendRun(run: TaskRun): TaskRun {
    const data = this.read()
    const other = data.runs.filter((item) => item.taskId !== run.taskId)
    const own = [run, ...data.runs.filter((item) => item.taskId === run.taskId)].slice(
      0,
      MAX_RUNS_PER_TASK
    )
    this.write({ ...data, runs: [...own, ...other] })
    return run
  }

  replaceRun(run: TaskRun): TaskRun {
    const data = this.read()
    const index = data.runs.findIndex((item) => item.id === run.id)
    if (index < 0) throw new Error('任务运行记录不存在')
    data.runs[index] = run
    this.write(data)
    return run
  }

  markInterrupted(now = new Date()): void {
    const data = this.read()
    const active = new Set(['queued', 'running', 'needs_attention'])
    const iso = now.toISOString()
    let changed = false
    data.runs = data.runs.map((run) => {
      if (!active.has(run.status)) return run
      changed = true
      return {
        ...run,
        status: 'interrupted' as const,
        finishedAt: iso,
        error: 'daemon 重启导致执行中断'
      }
    })
    data.tasks = data.tasks.map((task) => {
      if (!['queued', 'running', 'needs_attention'].includes(task.executionStatus)) return task
      changed = true
      return {
        ...task,
        boardStatus: 'review' as const,
        executionStatus: 'interrupted' as const,
        lastError: 'daemon 重启导致执行中断',
        updatedAt: iso
      }
    })
    if (changed) this.write(data)
  }

  private read(): TaskFileV1 {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as TaskFileV1
      if (
        parsed.schemaVersion !== SCHEMA_VERSION ||
        !Array.isArray(parsed.tasks) ||
        !Array.isArray(parsed.runs)
      ) {
        throw new Error('schema mismatch')
      }
      return { schemaVersion: SCHEMA_VERSION, tasks: parsed.tasks, runs: parsed.runs }
    } catch (error) {
      if (error instanceof TaskStoreCorruptError) throw error
      throw new TaskStoreCorruptError(this.filePath)
    }
  }

  private write(data: TaskFileV1): void {
    const temporary = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.filePath)
    chmodSync(this.filePath, 0o600)
  }
}
