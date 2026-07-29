import { describe, expect, it, vi } from 'vitest'
import {
  semanticTaskFollowUpFromHistory,
  sendTurnWithSemanticAutomation
} from '../src/main/domains/tasks/semantic-task-automation'
import type { CreateTaskInput, ManagedChatMessage, RuntimeHost } from '../src/shared/types'

const turnState = {
  sessionId: 'session-1',
  status: 'running' as const,
  startedAt: '2026-07-22T02:00:00.000Z',
  updatedAt: '2026-07-22T02:00:00.000Z',
  pendingPermission: null,
  error: null,
  queuedCount: 0
}

function setup(createTaskError?: Error, history: ManagedChatMessage[] = []) {
  const runtime = {
    sendTurn: vi.fn(async () => turnState),
    chatHistory: vi.fn(async () => history),
    listSessionViews: vi.fn(async () => [
      {
        id: 'session-1',
        name: '项目会话',
        toolId: 'codex',
        model: 'gpt-5.6',
        workspacePath: '/workspace/project',
        runtimeHostId: 'managed-windows',
        permissionPreset: 'safe'
      }
    ]),
    createTask: vi.fn(async (input: CreateTaskInput) => {
      if (createTaskError) throw createTaskError
      return { id: 'task-1', ...input }
    })
  }
  return { runtime, host: runtime as unknown as RuntimeHost }
}

function message(
  id: string,
  role: ManagedChatMessage['role'],
  text: string,
  createdAt: string
): ManagedChatMessage {
  return { id, role, text, status: 'completed', createdAt, updatedAt: createdAt }
}

describe('Chat 语义任务自动化', () => {
  it('发送被接受后创建任务并继承会话运行目标', async () => {
    const { runtime, host } = setup()
    const state = await sendTurnWithSemanticAutomation(
      host,
      'session-1',
      '每天上午9点提醒我生成日报'
    )

    expect(runtime.sendTurn.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.createTask.mock.invocationCallOrder[0]
    )
    expect(runtime.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '生成日报',
        prompt: '生成日报',
        workspacePath: '/workspace/project',
        runtimeHostId: 'managed-windows',
        assignee: { toolId: 'codex', model: 'gpt-5.6' },
        schedule: expect.objectContaining({ kind: 'cron', expression: '0 9 * * *' })
      })
    )
    expect(state.taskAutomation).toMatchObject({ status: 'created', taskId: 'task-1' })
  })

  it('普通聊天只发送原消息，不创建任务', async () => {
    const { runtime, host } = setup()
    const state = await sendTurnWithSemanticAutomation(host, 'session-1', '明天上午9点天气怎样')
    expect(state).toEqual(turnState)
    expect(runtime.createTask).not.toHaveBeenCalled()
  })

  it('把自然语言间隔计划创建到当前 Runtime', async () => {
    const { runtime, host } = setup()
    await sendTurnWithSemanticAutomation(host, 'session-1', '创建任务，每隔 2 小时检查 ISSUE')
    expect(runtime.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '检查 ISSUE',
        schedule: expect.objectContaining({
          kind: 'interval',
          everyMs: 2 * 60 * 60_000,
          enabled: true
        })
      })
    )
  })

  it('创建失败时保留已发送状态并返回可见失败原因', async () => {
    const { host } = setup(new Error('远程主机不允许任务管理'))
    const state = await sendTurnWithSemanticAutomation(
      host,
      'session-1',
      '每天上午9点提醒我生成日报'
    )
    expect(state).toMatchObject({
      sessionId: 'session-1',
      status: 'running',
      taskAutomation: { status: 'failed', error: '远程主机不允许任务管理' }
    })
  })

  it('用紧邻上一轮的未完成调度意图补全当前任务正文', async () => {
    const history = [
      message('previous', 'user', '设置每天上午9点执行的任务', '2026-07-22T02:00:00.000Z'),
      message('assistant', 'assistant', '请告诉我具体任务内容。', '2026-07-22T02:00:05.000Z'),
      message('current', 'user', '分析本项目未完成的ISSUE', '2026-07-22T02:00:20.000Z')
    ]
    const { runtime, host } = setup(undefined, history)

    const state = await sendTurnWithSemanticAutomation(host, 'session-1', '分析本项目未完成的ISSUE')

    expect(runtime.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '分析本项目未完成的ISSUE',
        prompt: '分析本项目未完成的ISSUE',
        schedule: expect.objectContaining({ kind: 'cron', expression: '0 9 * * *' })
      })
    )
    expect(state.taskAutomation).toMatchObject({ status: 'created', taskId: 'task-1' })
  })

  it('拒绝过期或没有 Agent 任务确认的历史上下文', () => {
    const current = message(
      'current',
      'user',
      '分析本项目未完成的ISSUE',
      '2026-07-22T03:00:01.000Z'
    )
    const stale = [
      message('previous', 'user', '设置每天上午9点执行的任务', '2026-07-22T02:00:00.000Z'),
      message('assistant', 'assistant', '请告诉我具体任务内容。', '2026-07-22T02:00:05.000Z'),
      current
    ]
    expect(semanticTaskFollowUpFromHistory(current.text, stale)).toBeNull()
    expect(semanticTaskFollowUpFromHistory(current.text, [stale[0], current])).toBeNull()
  })
})
