import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatManager } from '../src/main/domains/chat/manager'
import { getAdapter } from '../src/main/domains/adapters/registry'
import type { CliAdapter } from '../src/main/domains/adapters/types'
import type {
  AgentEvent,
  ManagedChatTimelineItem,
  ManagedQueuedTurn,
  PermissionPreset,
  WorkbenchSession
} from '../src/shared/types'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }

  finish(code = 0): void {
    this.emit('exit', code, null)
  }
}

function session(
  preset: PermissionPreset = 'safe',
  overrides: Partial<WorkbenchSession> = {}
): WorkbenchSession {
  return {
    id: 'session-1',
    name: 'Chat session',
    toolId: 'claude',
    workspacePath: '/tmp',
    terminalSessionId: null,
    nativeSessionId: null,
    surface: 'chat',
    permissionPreset: preset,
    favorite: false,
    pinned: false,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
    ...overrides
  }
}

const managers: ChatManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close()
})

async function setup(preset: PermissionPreset = 'safe', adapterOverride?: CliAdapter) {
  let current = session(preset)
  const children: FakeChild[] = []
  const launches: Array<{ command: string; args: string[] }> = []
  const events: AgentEvent[] = []
  const emittedTurnIds: Array<string | undefined> = []
  const timeline: ManagedChatTimelineItem[] = []
  const queuedTurns: ManagedQueuedTurn[] = []
  const manager = await ChatManager.create({
    approvalToken: 'approval-secret',
    getSession: (id) => (id === current.id ? current : null),
    bindNativeSession: (_id, nativeSessionId) => {
      current = { ...current, nativeSessionId }
      return current
    },
    getAdapter: adapterOverride ? () => adapterOverride : getAdapter,
    getProviderEnv: () => ({}),
    getProviderModel: () => undefined,
    nextTimelineSeq: () => timeline.length + 1,
    listQueuedTurns: (sessionId) => queuedTurns.filter((turn) => turn.sessionId === sessionId),
    enqueueTurn: (sessionId, input) => {
      const now = '2026-06-12T00:00:00.000Z'
      const created: ManagedQueuedTurn = {
        id: `queued-${queuedTurns.length + 1}`,
        sessionId,
        text: input.text,
        files: input.files ?? [],
        status: 'queued',
        createdAt: now,
        updatedAt: now
      }
      queuedTurns.push(created)
      return created
    },
    cancelQueuedTurn: (sessionId, queuedTurnId) => {
      const index = queuedTurns.findIndex(
        (turn) => turn.sessionId === sessionId && turn.id === queuedTurnId
      )
      if (index === -1) return false
      queuedTurns.splice(index, 1)
      return true
    },
    appendTimelineItem: (item) => {
      const created = {
        ...item,
        id: `timeline-${timeline.length + 1}`,
        createdAt: '2026-06-12T00:00:00.000Z'
      }
      timeline.push(created)
      return created
    },
    spawn: (command, args) => {
      const child = new FakeChild()
      children.push(child)
      launches.push({ command, args })
      return child
    },
    emit: (_sessionId, event, _timelineItem, turnId) => {
      events.push(event)
      emittedTurnIds.push(turnId)
    }
  })
  managers.push(manager)
  return {
    manager,
    children,
    launches,
    events,
    emittedTurnIds,
    timeline,
    queuedTurns,
    session: () => current
  }
}

async function postHook(
  manager: ChatManager,
  turnId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(manager.approvalUrl, {
    method: 'POST',
    headers: {
      authorization: 'Bearer approval-secret',
      'x-agent-os-turn': turnId,
      'content-type': 'application/json'
    },
    body: JSON.stringify(input)
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<Record<string, unknown>>
}

/** 派生自 claude（buildTurn/parser 可用）但覆写启动看门狗超时，用于批量适配器场景。 */
function adapterWithTimeout(ms: number | null): CliAdapter {
  const claude = getAdapter('claude')!
  return { ...claude, headlessJson: { ...claude.headlessJson!, startupTimeoutMs: ms } }
}

describe('ChatManager', () => {
  it('steer 中断当前回合后优先续跑，保留原生会话与既有排队项', async () => {
    const { manager, children, launches, queuedTurns, session: current } = await setup()
    await manager.sendTurn('session-1', '先做完整实现')
    children[0]?.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'native-steer-1',
        model: 'claude-test'
      })}\n`
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    manager.queueTurn('session-1', '最后补文档')

    const state = await manager.steer('session-1', '先修复失败测试')

    expect(children[0]?.killed).toBe(true)
    expect(state.status).toBe('running')
    expect(current().nativeSessionId).toBe('native-steer-1')
    expect(launches).toHaveLength(2)
    expect(launches[1]?.args).toContain('--resume')
    expect(launches[1]?.args.at(-1)).toBe('先修复失败测试')
    expect(queuedTurns.map((turn) => turn.text)).toEqual(['最后补文档'])
    expect(manager.history('session-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', status: 'interrupted' }),
        expect.objectContaining({ role: 'user', text: '先修复失败测试' })
      ])
    )

    children[1]?.finish(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(launches).toHaveLength(3)
    expect(launches[2]?.args.at(-1)).toBe('最后补文档')
  })

  it('删除会话时释放状态、历史与排队缓存', async () => {
    const { manager, queuedTurns } = await setup()
    await manager.sendTurn('session-1', '会被清理的消息')
    manager.queueTurn('session-1', '排队消息')
    expect(manager.history('session-1').length).toBeGreaterThan(0)
    expect(queuedTurns).toHaveLength(1)

    await manager.forgetSession('session-1')

    expect(manager.history('session-1')).toEqual([])
    expect(manager.state('session-1')).toMatchObject({ status: 'idle', queuedCount: 0 })
    expect(queuedTurns).toEqual([])
  })

  it('streams a turn, binds the protocol session id, and becomes idle', async () => {
    const { manager, children, launches, events, emittedTurnIds, session: current } = await setup()

    const state = await manager.sendTurn('session-1', 'hello')
    const turnId = manager.activeTurnId('session-1')
    expect(state.status).toBe('running')
    expect(state.turnId).toMatch(/^[0-9a-f-]{36}$/)
    expect(turnId).toBeTruthy()
    expect(launches[0]?.command).toBe('claude')
    expect(launches[0]?.args.at(-1)).toBe('hello')

    children[0]?.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'native-chat-1',
        model: 'claude-sonnet-4-5'
      })}\n`
    )
    children[0]?.stdout.write(
      `${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hi' }
        }
      })}\n`
    )
    children[0]?.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01 })}\n`
    )
    children[0]?.finish(0)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(current().nativeSessionId).toBe('native-chat-1')
    expect(events).toContainEqual({ kind: 'text-delta', text: 'hi' })
    expect(events).toContainEqual({
      kind: 'turn-end',
      status: 'completed',
      costUsd: 0.01
    })
    expect(emittedTurnIds.length).toBeGreaterThan(0)
    expect(emittedTurnIds.every((id) => id === state.turnId)).toBe(true)
    expect(manager.state('session-1').status).toBe('idle')
    expect(manager.state('session-1').turnId).toBeNull()
  })

  it('defers a guarded tool, resumes after allow-once, and allows the same tool use', async () => {
    const { manager, children, launches, events } = await setup('safe')
    await manager.sendTurn('session-1', 'edit a file')
    const firstTurnId = manager.activeTurnId('session-1')!

    const deferred = await postHook(manager, firstTurnId, {
      hook_event_name: 'PreToolUse',
      session_id: 'native-chat-1',
      tool_use_id: 'toolu-edit-1',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a.ts' }
    })
    expect(deferred).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer'
      }
    })
    const request = events.find(
      (event): event is Extract<AgentEvent, { kind: 'permission-request' }> =>
        event.kind === 'permission-request'
    )
    expect(request?.toolName).toBe('Edit')
    expect(manager.state('session-1').status).toBe('awaiting-permission')

    await manager.respondPermission('session-1', request!.requestId, 'once')
    expect(launches).toHaveLength(2)
    expect(launches[1]?.args).toContain('--resume')
    expect(launches[1]?.args.at(-1)).not.toBe('edit a file')
    const resumedTurnId = manager.activeTurnId('session-1')!
    const allowed = await postHook(manager, resumedTurnId, {
      hook_event_name: 'PreToolUse',
      session_id: 'native-chat-1',
      tool_use_id: 'toolu-edit-1',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a.ts' }
    })
    expect(allowed).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    })
    children[1]?.finish(0)
  })

  it('auto preset allows tools without emitting a permission card', async () => {
    const { manager, events } = await setup('auto')
    await manager.sendTurn('session-1', 'run tests')
    const turnId = manager.activeTurnId('session-1')!

    const response = await postHook(manager, turnId, {
      hook_event_name: 'PreToolUse',
      session_id: 'native-chat-1',
      tool_use_id: 'toolu-bash-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    })

    expect(response).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    })
    expect(events.some((event) => event.kind === 'permission-request')).toBe(false)
  })

  it('returns deny when the user rejects a deferred tool call', async () => {
    const { manager, events } = await setup('safe')
    await manager.sendTurn('session-1', 'run a command')
    await postHook(manager, manager.activeTurnId('session-1')!, {
      hook_event_name: 'PreToolUse',
      session_id: 'native-chat-1',
      tool_use_id: 'toolu-bash-denied',
      tool_name: 'Bash',
      tool_input: { command: 'npm publish' }
    })
    const request = events.find(
      (event): event is Extract<AgentEvent, { kind: 'permission-request' }> =>
        event.kind === 'permission-request'
    )!

    await manager.respondPermission('session-1', request.requestId, 'deny')
    const denied = await postHook(manager, manager.activeTurnId('session-1')!, {
      hook_event_name: 'PreToolUse',
      session_id: 'native-chat-1',
      tool_use_id: 'toolu-bash-denied',
      tool_name: 'Bash',
      tool_input: { command: 'npm publish' }
    })

    expect(denied).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny'
      }
    })
  })

  it('keeps an always-allow decision for later turns in the same session', async () => {
    const { manager, children, events } = await setup('safe')
    await manager.sendTurn('session-1', 'edit first file')
    const firstTurnId = manager.activeTurnId('session-1')!
    await postHook(manager, firstTurnId, {
      hook_event_name: 'PreToolUse',
      session_id: 'native-chat-1',
      tool_use_id: 'toolu-edit-1',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a.ts' }
    })
    const request = events.find(
      (event): event is Extract<AgentEvent, { kind: 'permission-request' }> =>
        event.kind === 'permission-request'
    )!
    await manager.respondPermission('session-1', request.requestId, 'always')
    const resumedTurnId = manager.activeTurnId('session-1')!
    await postHook(manager, resumedTurnId, {
      hook_event_name: 'PreToolUse',
      session_id: 'native-chat-1',
      tool_use_id: 'toolu-edit-1',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a.ts' }
    })
    children[1]?.finish(0)
    await new Promise((resolve) => setTimeout(resolve, 10))

    await manager.sendTurn('session-1', 'edit second file')
    const nextTurnId = manager.activeTurnId('session-1')!
    const allowed = await postHook(manager, nextTurnId, {
      hook_event_name: 'PreToolUse',
      session_id: 'native-chat-1',
      tool_use_id: 'toolu-edit-2',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/b.ts' }
    })

    expect(allowed).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    })
    expect(events.filter((event) => event.kind === 'permission-request')).toHaveLength(1)
  })

  it('interrupts the active child and records an interrupted turn', async () => {
    const { manager, children, events } = await setup()
    await manager.sendTurn('session-1', 'long task')

    await expect(manager.interrupt('session-1')).resolves.toBe(true)

    expect(children[0]?.killed).toBe(true)
    expect(events).toContainEqual({ kind: 'turn-end', status: 'interrupted' })
    expect(manager.state('session-1').status).toBe('interrupted')
  })

  it('queues a turn while another turn is active and drains it after completion', async () => {
    const { manager, children, launches, queuedTurns } = await setup()
    await manager.sendTurn('session-1', 'first prompt')

    const queued = manager.queueTurn('session-1', 'second prompt', ['/tmp/spec.md'])

    expect(queued).toMatchObject({
      text: 'second prompt',
      files: ['/tmp/spec.md']
    })
    expect(manager.state('session-1')).toMatchObject({
      status: 'running',
      queuedCount: 1
    })
    expect(children).toHaveLength(1)

    children[0]?.stdout.write(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })}\n`
    )
    children[0]?.finish(0)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(queuedTurns).toHaveLength(0)
    expect(children).toHaveLength(2)
    expect(launches[1]).toBeTruthy()
    expect(
      manager
        .history('session-1')
        .some((message) => message.role === 'user' && message.text === 'second prompt')
    ).toBe(true)
    expect(manager.state('session-1')).toMatchObject({
      status: 'running',
      queuedCount: 0
    })
  })

  it('cancels a queued turn before it is drained', async () => {
    const { manager, children, queuedTurns } = await setup()
    await manager.sendTurn('session-1', 'first prompt')
    const queued = manager.queueTurn('session-1', 'second prompt')

    expect(manager.cancelQueuedTurn('session-1', queued.id)).toBe(true)
    expect(manager.cancelQueuedTurn('session-1', queued.id)).toBe(false)
    expect(manager.state('session-1').queuedCount).toBe(0)

    children[0]?.finish(0)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(queuedTurns).toHaveLength(0)
    expect(children).toHaveLength(1)
  })

  it('kills a batch adapter that emits no event within its startup timeout', async () => {
    // 模拟 hermes --quiet：批量化输出，spawn 后一段时间内 stdout 全程静默。
    // 默认 90s 看门狗会把这种合法的「长静默」误判为启动卡死；这里用 50ms 验证
    // 看门狗逻辑本身仍能兜底杀掉真正卡死的进程。
    const { manager, children } = await setup('safe', adapterWithTimeout(50))
    await manager.sendTurn('session-1', 'silent batch')
    expect(children[0]?.killed).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(children[0]?.killed).toBe(true)
    expect(manager.state('session-1').status).toBe('failed')
  })

  it('surfaces the last runtime error when the process later exits with noisy stderr', async () => {
    const { manager, children, events, timeline } = await setup()
    await manager.sendTurn('session-1', 'hello')

    children[0]?.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 10,
        error_status: 529,
        error: 'overloaded'
      })}\n`
    )
    children[0]?.stderr.write(
      '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login\n'
    )
    children[0]?.finish(1)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(manager.state('session-1')).toMatchObject({
      status: 'failed',
      error: '连接异常（529 overloaded），正在进行第 1/10 次重试'
    })
    expect(events.at(-1)).toEqual({
      kind: 'error',
      message: '连接异常（529 overloaded），正在进行第 1/10 次重试'
    })
    expect(timeline.at(-1)).toMatchObject({
      type: 'error',
      content: '连接异常（529 overloaded），正在进行第 1/10 次重试',
      isError: true
    })
  })

  it('does not kill a batch adapter whose startup watchdog is disabled', async () => {
    // startupTimeoutMs: null 表示禁用看门狗、仅靠进程退出收尾——静默期再长也不误杀。
    const { manager, children } = await setup('safe', adapterWithTimeout(null))
    await manager.sendTurn('session-1', 'silent batch')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(children[0]?.killed).toBe(false)
    expect(manager.state('session-1').status).toBe('running')
  })

  it('rejects unsupported attachments before creating a turn or spawning the Agent', async () => {
    const { manager, children } = await setup('safe', getAdapter('cursor-agent'))
    await expect(manager.sendTurn('session-1', '查看附件', ['/tmp/spec.md'])).rejects.toThrow(
      '不支持'
    )
    expect(children).toHaveLength(0)
    expect(manager.state('session-1').status).toBe('idle')
  })

  it('binds the native session id printed to stderr at turn exit (hermes --quiet)', async () => {
    // hermes --quiet 把 session_id 打到 stderr、最终回答打到 stdout，且都在结束时才输出。
    // stdout 解析器全程拿不到 session-bound；exit(code=0) 时从缓冲的 stderr 兜底绑定，
    // 供下一回合 --resume 接续多轮记忆（修「hermes 每回合孤立、无多轮记忆」）。
    const { manager, children, session: current } = await setup('auto', getAdapter('hermes'))
    await manager.sendTurn('session-1', '检查服务状态')
    // 批量输出：仅在结束时吐最终回答（stdout）+ session_id（stderr）
    children[0]?.stdout.write('服务运行正常\n')
    children[0]?.stderr.write('\nsession_id: 20260702_200140_9fdca8\n')
    children[0]?.finish(0)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(current().nativeSessionId).toBe('20260702_200140_9fdca8')
  })
})
