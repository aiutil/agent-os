import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { TaskRepository, TaskStoreCorruptError } from '../src/main/domains/tasks/repository'
import type { CreateTaskInput, TaskRun } from '../src/shared/types'

function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    title: '每日检查',
    prompt: '检查项目状态',
    workspacePath: '/project',
    assignee: { toolId: 'codex' },
    ...overrides
  }
}

function repository(): { path: string; repository: TaskRepository } {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-os-tasks-')), 'tasks.json')
  return { path, repository: new TaskRepository(path) }
}

describe('TaskRepository', () => {
  it('persists created tasks and normalized schedules', () => {
    const { path, repository: store } = repository()
    const task = store.createTask(
      input({
        schedule: {
          kind: 'cron',
          expression: '0 9 * * 1-5',
          timeZone: 'Asia/Shanghai',
          enabled: true,
          misfirePolicy: 'run_once'
        }
      }),
      new Date('2026-07-18T00:00:00.000Z')
    )

    expect(task.title).toBe('每日检查')
    expect(task.schedule?.nextRunAt).toBe('2026-07-20T01:00:00.000Z')
    expect(new TaskRepository(path).getTask(task.id)).toEqual(task)
  })

  it('does not allow an active task to be moved manually', () => {
    const { repository: store } = repository()
    const task = store.createTask(input())
    store.replaceTask({ ...task, executionStatus: 'running', boardStatus: 'in_progress' })
    expect(() => store.updateTask(task.id, { boardStatus: 'done' })).toThrow('运行中的任务')
  })

  it('keeps only the newest fifty runs for each task', () => {
    const { repository: store } = repository()
    const task = store.createTask(input())
    for (let index = 0; index < 55; index += 1) {
      const run: TaskRun = {
        id: `run-${index}`,
        taskId: task.id,
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date(2026, 0, 1, 0, index).toISOString()
      }
      store.appendRun(run)
    }
    expect(store.listRuns(task.id)).toHaveLength(50)
    expect(store.listRuns(task.id).some((run) => run.id === 'run-54')).toBe(true)
    expect(store.listRuns(task.id).some((run) => run.id === 'run-0')).toBe(false)
  })

  it('recovers an enabled scheduled run once and leaves later interruption for manual retry', () => {
    const { repository: store } = repository()
    const task = store.createTask(input({
      schedule: {
        kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC', enabled: true, misfirePolicy: 'run_once'
      }
    }))
    const run: TaskRun = {
      id: 'run-active',
      taskId: task.id,
      trigger: 'schedule',
      status: 'running',
      startedAt: '2026-07-18T00:00:00.000Z'
    }
    store.appendRun(run)
    store.replaceTask({ ...task, latestRunId: run.id, executionStatus: 'running' })
    const recoveries = store.prepareStartupRecovery(new Date('2026-07-18T01:00:00.000Z'))

    expect(recoveries).toHaveLength(1)
    expect(store.listRuns(task.id)[0]).toMatchObject({
      status: 'queued',
      interruptedAt: '2026-07-18T01:00:00.000Z',
      recoveryStartedAt: '2026-07-18T01:00:00.000Z',
      autoRecovered: true
    })
    expect(store.getTask(task.id)).toMatchObject({
      boardStatus: 'in_progress',
      executionStatus: 'queued'
    })

    expect(store.prepareStartupRecovery(new Date('2026-07-18T02:00:00.000Z'))).toEqual([])
    expect(store.listRuns(task.id)[0]).toMatchObject({
      status: 'interrupted',
      finishedAt: '2026-07-18T02:00:00.000Z',
      error: '自动恢复再次被 daemon 重启中断，请手动重跑'
    })
  })

  it('does not auto-recover manual runs or disabled schedules', () => {
    const { repository: store } = repository()
    const manualTask = store.createTask(input({ title: '手动任务' }))
    const disabledTask = store.createTask(input({
      title: '停用计划',
      schedule: {
        kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC', enabled: false, misfirePolicy: 'run_once'
      }
    }))
    for (const [task, trigger] of [[manualTask, 'manual'], [disabledTask, 'schedule']] as const) {
      const run: TaskRun = { id: `run-${trigger}`, taskId: task.id, trigger, status: 'running' }
      store.appendRun(run)
      store.replaceTask({ ...task, latestRunId: run.id, executionStatus: 'running' })
    }

    expect(store.prepareStartupRecovery(new Date('2026-07-18T01:00:00.000Z'))).toEqual([])
    expect(store.listRuns(manualTask.id)[0].status).toBe('interrupted')
    expect(store.listRuns(disabledTask.id)[0].status).toBe('interrupted')
  })

  it('preserves and reports a corrupted store', () => {
    const { path } = repository()
    writeFileSync(path, '{broken')
    const store = new TaskRepository(path)
    expect(() => store.listTasks()).toThrow(TaskStoreCorruptError)
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
})
