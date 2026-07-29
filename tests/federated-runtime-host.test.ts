import { describe, expect, it } from 'vitest'
import { FederatedRuntimeHost } from '../src/main/domains/runtime/federated-runtime-host'
import type { RuntimeHost } from '../src/main/domains/runtime/protocol'
import type { AgentTask, HostEvent } from '../src/shared/types'

// 最小 Fake RuntimeHost：实现订阅/emit + 关键方法，其余方法置空。
function makeHost(id: string) {
  const listeners = new Set<(e: HostEvent) => void>()
  const writes: Array<[string, string]> = []
  const steers: Array<[string, string, string[] | undefined]> = []
  const taskRuns: string[] = []
  const tasks: AgentTask[] = []
  const host = {
    id,
    writes,
    steers,
    taskRuns,
    emit(event: HostEvent) {
      for (const l of listeners) l(event)
    },
    subscribe(l: (e: HostEvent) => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    async createSession(input: { name: string }) {
      return {
        session: { id: `${id}-s`, name: input.name } as never,
        terminal: { sessionId: `${id}-t` } as never
      }
    },
    async listSessions() {
      return [{ id: `${id}-s`, name: 's', terminalSessionId: `${id}-t` } as never]
    },
    async write(sessionId: string, data: string) {
      writes.push([sessionId, data])
      return true
    },
    async steerTurn(sessionId: string, text: string, files?: string[]) {
      steers.push([sessionId, text, files])
      return {
        sessionId,
        turnId: `${id}-steer`,
        status: 'running' as const,
        startedAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
        pendingPermission: null,
        error: null,
        queuedCount: 0
      }
    },
    async states() {
      return []
    },
    async listRuntimes() {
      return []
    },
    async listSessionViews() {
      return []
    },
    async listTasks() {
      return tasks
    },
    async createTask(input: {
      title: string
      prompt: string
      workspacePath: string
      assignee: { toolId: string }
    }) {
      const task: AgentTask = {
        id: `${id}-task`,
        title: input.title,
        prompt: input.prompt,
        workspacePath: input.workspacePath,
        assignee: input.assignee,
        boardStatus: 'todo',
        executionStatus: 'idle',
        permissionPreset: 'safe',
        sessionPolicy: 'new',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z'
      }
      tasks.push(task)
      return task
    },
    async runTaskNow(taskId: string) {
      taskRuns.push(taskId)
      return { id: `${taskId}-run`, taskId, trigger: 'manual' as const, status: 'queued' as const }
    }
  }
  return host as typeof host & RuntimeHost
}

describe('FederatedRuntimeHost', () => {
  it('createSession 按 runtimeHostId 路由到对应主机，并记录会话归属', async () => {
    const local = makeHost('local')
    const remote = makeHost('remoteA')
    const fed = new FederatedRuntimeHost(local, 'local')
    fed.addHost('remoteA', remote)

    const handle = await fed.createSession({
      name: 't',
      toolId: 'shell',
      workspacePath: '/tmp',
      runtimeHostId: 'remoteA'
    })
    expect(handle.session.id).toBe('remoteA-s')

    // 会话级方法路由到远程（session id 与 terminal id 都已记录）
    await fed.write('remoteA-s', 'a')
    await fed.write('remoteA-t', 'b')
    await fed.steerTurn('remoteA-s', 'correct course', ['/tmp/context.txt'])
    expect(remote.writes).toEqual([
      ['remoteA-s', 'a'],
      ['remoteA-t', 'b']
    ])
    expect(remote.steers).toEqual([
      ['remoteA-s', 'correct course', ['/tmp/context.txt']]
    ])
    expect(local.writes).toEqual([])
    expect(local.steers).toEqual([])
  })

  it('未指定 runtimeHostId 时落到本机', async () => {
    const local = makeHost('local')
    const fed = new FederatedRuntimeHost(local, 'local')
    const handle = await fed.createSession({ name: 't', toolId: 'shell', workspacePath: '/tmp' })
    expect(handle.session.id).toBe('local-s')
    await fed.write('local-s', 'x')
    expect(local.writes).toEqual([['local-s', 'x']])
  })

  it('listSessions 合并各主机并打 runtimeHostId', async () => {
    const local = makeHost('local')
    const remote = makeHost('remoteA')
    const fed = new FederatedRuntimeHost(local, 'local')
    fed.addHost('remoteA', remote)
    const sessions = await fed.listSessions()
    const byHost = Object.fromEntries(sessions.map((s) => [s.id, s.runtimeHostId]))
    expect(byHost['local-s']).toBe('local')
    expect(byHost['remoteA-s']).toBe('remoteA')
  })

  it('合并各主机事件，并据事件学习会话归属用于后续路由', async () => {
    const local = makeHost('local')
    const remote = makeHost('remoteA')
    const fed = new FederatedRuntimeHost(local, 'local')
    fed.addHost('remoteA', remote)

    const received: HostEvent[] = []
    fed.subscribe((e) => received.push(e))

    // 远程推一个未知会话的事件 → 转发 + 记录归属
    remote.emit({ kind: 'pty-data', sessionId: 'x-1', bytes: 'hi' })
    expect(received).toHaveLength(1)

    await fed.write('x-1', 'z')
    expect(remote.writes).toEqual([['x-1', 'z']])
    expect(local.writes).toEqual([])
  })

  it('removeHost 注销远程主机并清理路由，本机不可移除', async () => {
    const local = makeHost('local')
    const remote = makeHost('remoteA')
    const fed = new FederatedRuntimeHost(local, 'local')
    fed.addHost('remoteA', remote)
    await fed.createSession({
      name: 't',
      toolId: 'shell',
      workspacePath: '/tmp',
      runtimeHostId: 'remoteA'
    })

    fed.removeHost('remoteA')
    expect(fed.hasHost('remoteA')).toBe(false)
    // 路由已清，会话级调用回退本机
    await fed.write('remoteA-s', 'a')
    expect(local.writes).toEqual([['remoteA-s', 'a']])

    fed.removeHost('local')
    expect(fed.hasHost('local')).toBe(true) // 本机不可移除
  })

  it('任务按目标主机创建、聚合盖戳，并按 taskId 路由执行', async () => {
    const local = makeHost('local')
    const remote = makeHost('remoteA')
    const fed = new FederatedRuntimeHost(local, 'local')
    fed.addHost('remoteA', remote)

    const created = await fed.createTask({
      title: '远程巡检',
      prompt: '检查状态',
      workspacePath: '/srv/project',
      runtimeHostId: 'remoteA',
      assignee: { toolId: 'codex' }
    })
    expect(created.runtimeHostId).toBe('remoteA')
    await fed.runTaskNow(created.id)
    expect(remote.taskRuns).toEqual(['remoteA-task'])
    expect(local.taskRuns).toEqual([])

    const listed = await fed.listTasks()
    expect(listed).toContainEqual(
      expect.objectContaining({ id: 'remoteA-task', runtimeHostId: 'remoteA' })
    )
  })

  it('只在会话/任务成功创建后触发一次匿名分析 hook', async () => {
    const local = makeHost('local')
    const sessions: string[] = []
    const tasks: string[] = []
    const fed = new FederatedRuntimeHost(local, 'local', {
      sessionCreated: (input) => sessions.push(input.toolId),
      taskCreated: (_input, task) => tasks.push(`${task.id}:${task.runtimeHostId}`)
    })
    await fed.createSession({ name: 't', toolId: 'codex', workspacePath: '/tmp' })
    await fed.createTask({
      title: 't',
      prompt: 'p',
      workspacePath: '/tmp',
      assignee: { toolId: 'codex' }
    })
    expect(sessions).toEqual(['codex'])
    expect(tasks).toEqual(['local-task:local'])
  })
})
