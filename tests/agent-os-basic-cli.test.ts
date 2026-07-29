import { describe, expect, it, vi } from 'vitest'
import { createAgentOsCli, extractPackagedCliArgs } from '../src/main/cli'
import type { RuntimeHost } from '../src/shared/types'

function setup() {
  const close = vi.fn(async () => undefined)
  const runtime = {
    hostStatus: vi.fn(async () => ({ mode: 'daemon', connection: 'connected', sessionCount: 1 })),
    listRuntimes: vi.fn(async () => [
      {
        toolId: 'codex',
        displayName: 'Codex',
        channel: 'pty',
        canResume: true,
        capabilities: { chat: true },
        health: 'ready'
      }
    ]),
    listSessionViews: vi.fn(async () => [
      {
        id: 'session-1',
        status: 'idle',
        toolId: 'codex',
        name: '发布检查'
      }
    ]),
    createSession: vi.fn(async (input) => ({
      session: { id: 'session-1', ...input },
      terminal: null
    })),
    sendTurn: vi.fn(async (sessionId: string) => ({
      sessionId,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingPermission: null,
      error: null,
      queuedCount: 0
    })),
    listTasks: vi.fn(async () => [
      {
        id: 'task-1',
        executionStatus: 'idle',
        title: '日报'
      }
    ]),
    createTask: vi.fn(async (input) => ({ id: 'task-1', ...input, executionStatus: 'idle' })),
    runTaskNow: vi.fn(async (taskId: string) => ({
      id: 'run-1',
      taskId,
      trigger: 'manual',
      status: 'queued'
    }))
  } as unknown as RuntimeHost
  const cli = createAgentOsCli({
    runtime,
    startRelay: async () => ({ targetSessionId: '', relayLinkId: '' }),
    listRelayTargets: async () => [],
    close
  })
  return { cli, runtime, close }
}

describe('Agent OS 基础运营 CLI', () => {
  it('从桌面可执行文件 argv 提取无窗口 CLI 参数', () => {
    expect(
      extractPackagedCliArgs(['C:\\Program Files\\Agent OS\\Agent OS.exe', '--cli', 'status', '--json'])
    ).toEqual(['status', '--json'])
    expect(extractPackagedCliArgs(['/Applications/Agent OS.app/Contents/MacOS/Agent OS'])).toBeNull()
    expect(extractPackagedCliArgs(['Agent OS.exe', '--cli'])).toEqual([])
  })

  it('帮助列出所有基础命令', async () => {
    const { cli } = setup()
    const result = await cli.run(['--help'])
    expect(result.exitCode).toBe(0)
    for (const command of [
      'status',
      'agents',
      'sessions',
      'session-create',
      'send',
      'tasks',
      'task-create',
      'task-run'
    ]) {
      expect(result.stdout).toContain(`agent-os ${command}`)
    }
    expect(result.stdout).toContain('"Agent OS.exe" --cli status --json')
  })

  it.each([
    ['status', 'connection', 'connected'],
    ['agents', '0.toolId', 'codex'],
    ['sessions', '0.id', 'session-1'],
    ['tasks', '0.id', 'task-1']
  ])('%s 读取命令支持 JSON', async (command, path, expected) => {
    const { cli } = setup()
    const result = await cli.run([command, '--json'])
    const value = path
      .split('.')
      .reduce<unknown>(
        (current, key) => (current as Record<string, unknown>)[key],
        JSON.parse(result.stdout)
      )
    expect(result.exitCode).toBe(0)
    expect(value).toBe(expected)
  })

  it('列出 Agent 并支持 JSON', async () => {
    const { cli } = setup()
    const result = await cli.run(['agents', '--json'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)[0]).toMatchObject({ toolId: 'codex', health: 'ready' })
  })

  it('创建会话并向会话发送指令', async () => {
    const { cli, runtime } = setup()
    const created = await cli.run([
      'session-create',
      '--tool',
      'codex',
      '--workspace',
      '.',
      '--json'
    ])
    expect(JSON.parse(created.stdout).session.id).toBe('session-1')
    const sent = await cli.run(['send', '--session', 'session-1', '--prompt', '检查发布', '--json'])
    expect(JSON.parse(sent.stdout)).toMatchObject({ sessionId: 'session-1', status: 'running' })
    expect(runtime.sendTurn).toHaveBeenCalledWith('session-1', '检查发布')
  })

  it('创建一次性任务并立即运行', async () => {
    const { cli, runtime } = setup()
    const created = await cli.run([
      'task-create',
      '--title',
      '日报',
      '--prompt',
      '生成日报',
      '--tool',
      'codex',
      '--workspace',
      '.',
      '--at',
      '2026-07-23T00:00:00Z',
      '--json'
    ])
    expect(JSON.parse(created.stdout).id).toBe('task-1')
    expect(runtime.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '日报',
        schedule: expect.objectContaining({ kind: 'once', runAt: '2026-07-23T00:00:00.000Z' })
      })
    )
    const run = await cli.run(['task-run', '--task', 'task-1', '--json'])
    expect(JSON.parse(run.stdout)).toMatchObject({ id: 'run-1', taskId: 'task-1' })
  })

  it('缺少必填参数时返回非零且不调用 Runtime', async () => {
    const { cli, runtime } = setup()
    const result = await cli.run(['send', '--session', 'session-1'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--prompt')
    expect(runtime.sendTurn).not.toHaveBeenCalled()
  })

  it.each([
    ['session-create', ['session-create'], '--tool'],
    ['send/session', ['send', '--prompt', '检查发布'], '--session'],
    ['send/prompt', ['send', '--session', 'session-1'], '--prompt'],
    ['task-create/title', ['task-create', '--prompt', '日报', '--tool', 'codex'], '--title'],
    ['task-create/prompt', ['task-create', '--title', '日报', '--tool', 'codex'], '--prompt'],
    ['task-create/tool', ['task-create', '--title', '日报', '--prompt', '生成'], '--tool'],
    ['task-run', ['task-run'], '--task']
  ])('%s 缺参返回非零', async (_name, args, expected) => {
    const { cli } = setup()
    const result = await cli.run(args)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(expected)
  })

  it('命令结束关闭 Runtime 资源', async () => {
    const { cli, close } = setup()
    await cli.run(['status'])
    expect(close).toHaveBeenCalledOnce()
  })
})
