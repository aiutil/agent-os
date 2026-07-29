import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { TaskRepository } from '../src/main/domains/tasks/repository'
import { TaskService } from '../src/main/domains/tasks/service'
import type {
  ChatTurnState,
  HostEvent,
  RuntimeHost,
  RuntimeSessionHandle,
  WorkbenchSession
} from '../src/shared/types'

function session(id = 'task-session'): WorkbenchSession {
  const now = '2026-07-18T01:00:00.000Z'
  return {
    id,
    name: 'task',
    toolId: 'codex',
    workspacePath: '/project',
    terminalSessionId: null,
    nativeSessionId: null,
    surface: 'chat',
    permissionPreset: 'safe',
    favorite: false,
    pinned: false,
    segments: [],
    source: 'task',
    createdAt: now,
    updatedAt: now
  }
}

function runtimeDouble(): RuntimeHost & {
  emit(event: HostEvent): void
  created: number
  sentPrompts: string[]
} {
  const listeners = new Set<(event: HostEvent) => void>()
  const sessions: WorkbenchSession[] = []
  const runtime = {
    created: 0,
    sentPrompts: [] as string[],
    subscribe(listener: (event: HostEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event: HostEvent) {
      for (const listener of listeners) listener(event)
    },
    async listRuntimes() {
      return [
        {
          toolId: 'codex',
          displayName: 'Codex',
          channel: 'pty' as const,
          canResume: true,
          health: 'ready' as const,
          capabilities: {
            terminal: true,
            chat: true,
            terminalResume: true,
            chatContinuation: 'native' as const,
            linkedTerminal: true,
            attachments: { images: true, files: true }
          }
        }
      ]
    },
    async listSessions() {
      return sessions
    },
    async createSession(): Promise<RuntimeSessionHandle> {
      runtime.created += 1
      const created = session(`task-session-${runtime.created}`)
      sessions.push(created)
      return { session: created, terminal: null }
    },
    async sendTurn(sessionId: string, prompt: string): Promise<ChatTurnState> {
      runtime.sentPrompts.push(prompt)
      return {
        sessionId,
        status: 'running',
        startedAt: '2026-07-18T01:00:00.000Z',
        updatedAt: '2026-07-18T01:00:00.000Z',
        pendingPermission: null,
        error: null,
        queuedCount: 0
      }
    }
  }
  return runtime as unknown as RuntimeHost & {
    emit(event: HostEvent): void
    created: number
    sentPrompts: string[]
  }
}

function setup(now = new Date('2026-07-18T01:00:00.000Z')) {
  const file = join(mkdtempSync(join(tmpdir(), 'agent-os-task-service-')), 'tasks.json')
  const repository = new TaskRepository(file)
  const runtime = runtimeDouble()
  const events: Array<{ reason: string }> = []
  const service = new TaskService({
    repository,
    runtime: () => runtime,
    emit: (event) => events.push(event),
    now: () => now,
    tickMs: 60_000,
    workspaceExists: () => true
  })
  return { repository, runtime, events, service }
}

describe('TaskService', () => {
  it('moves a manual run through running, attention and review', async () => {
    const { repository, runtime, service } = setup()
    const task = service.createTask({
      title: '审计',
      prompt: '检查代码\n保留换行',
      workspacePath: '/project',
      assignee: { toolId: 'codex' }
    })
    service.start()
    service.runTaskNow(task.id)
    await vi.waitFor(() => expect(repository.getTask(task.id)?.executionStatus).toBe('running'))
    expect(runtime.sentPrompts).toEqual(['检查代码\n保留换行'])
    const sessionId = repository.getTask(task.id)?.latestSessionId
    expect(sessionId).toBeTruthy()

    runtime.emit({
      kind: 'agent-event',
      sessionId: sessionId!,
      event: {
        kind: 'permission-request',
        requestId: 'p1',
        toolName: 'shell',
        input: {},
        suggestions: []
      }
    })
    expect(repository.getTask(task.id)?.executionStatus).toBe('needs_attention')

    runtime.emit({
      kind: 'agent-event',
      sessionId: sessionId!,
      event: { kind: 'turn-end', status: 'completed' }
    })
    expect(repository.getTask(task.id)).toMatchObject({
      boardStatus: 'review',
      executionStatus: 'succeeded'
    })
    expect(repository.listRuns(task.id)[0]).toMatchObject({ status: 'succeeded', sessionId })
    service.close()
  })

  it('coalesces several missed cron occurrences into one run_once execution', async () => {
    const { repository, runtime, service } = setup()
    const task = service.createTask({
      title: '日报',
      prompt: '生成日报',
      workspacePath: '/project',
      assignee: { toolId: 'codex' },
      schedule: {
        kind: 'cron',
        expression: '0 9 * * *',
        timeZone: 'UTC',
        enabled: true,
        misfirePolicy: 'run_once'
      }
    })
    repository.updateTask(
      task.id,
      {
        schedule: { ...task.schedule!, nextRunAt: '2026-07-15T09:00:00.000Z' }
      },
      new Date('2026-07-15T08:00:00.000Z')
    )

    await service.tick()
    await vi.waitFor(() => expect(runtime.created).toBe(1))
    expect(repository.listRuns(task.id)).toHaveLength(1)
    expect(repository.getTask(task.id)?.schedule?.nextRunAt).toBe('2026-07-18T09:00:00.000Z')
    service.close()
  })

  it('coalesces missed interval occurrences from the stable anchor into one run_once execution', async () => {
    const { repository, runtime, service } = setup()
    const task = service.createTask({
      title: '间隔巡检',
      prompt: '检查间隔任务',
      workspacePath: '/project',
      assignee: { toolId: 'codex' },
      schedule: {
        kind: 'interval',
        everyMs: 30 * 60_000,
        anchorAt: '2026-07-15T00:00:00.000Z',
        timeZone: 'UTC',
        enabled: true,
        misfirePolicy: 'run_once'
      }
    })
    repository.updateTask(
      task.id,
      {
        schedule: { ...task.schedule!, nextRunAt: '2026-07-17T23:30:00.000Z' }
      },
      new Date('2026-07-17T23:00:00.000Z')
    )

    await service.tick()
    await vi.waitFor(() => expect(runtime.created).toBe(1))
    expect(repository.listRuns(task.id)).toHaveLength(1)
    expect(repository.listRuns(task.id)[0].scheduledFor).toBe('2026-07-17T23:30:00.000Z')
    expect(repository.getTask(task.id)?.schedule?.nextRunAt).toBe('2026-07-18T01:30:00.000Z')
    service.close()
  })

  it('records a skipped interval misfire without starting an agent', async () => {
    const { repository, runtime, service } = setup()
    const task = service.createTask({
      title: '跳过巡检',
      prompt: '检查间隔任务',
      workspacePath: '/project',
      assignee: { toolId: 'codex' },
      schedule: {
        kind: 'interval',
        everyMs: 30 * 60_000,
        anchorAt: '2026-07-15T00:00:00.000Z',
        timeZone: 'UTC',
        enabled: true,
        misfirePolicy: 'skip'
      }
    })
    repository.updateTask(
      task.id,
      {
        schedule: { ...task.schedule!, nextRunAt: '2026-07-17T23:30:00.000Z' }
      },
      new Date('2026-07-17T23:00:00.000Z')
    )

    await service.tick()
    expect(runtime.created).toBe(0)
    expect(repository.listRuns(task.id)[0]).toMatchObject({
      status: 'skipped',
      scheduledFor: '2026-07-17T23:30:00.000Z'
    })
    expect(repository.getTask(task.id)?.schedule?.nextRunAt).toBe('2026-07-18T01:30:00.000Z')
    service.close()
  })

  it('records a skipped run without starting an agent for a missed skip schedule', async () => {
    const { repository, runtime, service } = setup()
    const task = service.createTask({
      title: '巡检',
      prompt: '巡检',
      workspacePath: '/project',
      assignee: { toolId: 'codex' },
      schedule: {
        kind: 'once',
        runAt: '2026-07-17T01:00:00.000Z',
        timeZone: 'UTC',
        enabled: true,
        misfirePolicy: 'skip'
      }
    })
    await service.tick()
    expect(runtime.created).toBe(0)
    expect(repository.listRuns(task.id)[0]).toMatchObject({ status: 'skipped' })
    expect(repository.getTask(task.id)?.schedule?.enabled).toBe(false)
    service.close()
  })
})
