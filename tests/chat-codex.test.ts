import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatManager } from '../src/main/domains/chat/manager'
import { getAdapter } from '../src/main/domains/adapters/registry'
import type {
  AgentEvent,
  ManagedChatMessage,
  ManagedChatMessageStatus,
  WorkbenchSession
} from '../src/shared/types'

// 捕获写入 stdin 的内容，用于验证 prompt 投递与 transcript 注入。
class FakeStdin {
  data: string | null = null
  destroyed = false
  on(): this {
    return this
  }
  end(chunk?: string): void {
    if (typeof chunk === 'string') this.data = chunk
    this.destroyed = true
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new FakeStdin()
  kill(): boolean {
    this.emit('exit', null, 'SIGTERM')
    return true
  }
  finish(code = 0): void {
    this.emit('exit', code, null)
  }
}

function codexSession(overrides: Partial<WorkbenchSession> = {}): WorkbenchSession {
  return {
    id: 'session-1',
    name: 'Codex chat',
    toolId: 'codex',
    workspacePath: '/tmp',
    terminalSessionId: null,
    nativeSessionId: null,
    surface: 'chat',
    permissionPreset: 'safe',
    favorite: false,
    pinned: false,
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...overrides
  }
}

const managers: ChatManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close()
})

interface SharedHistory {
  messages: ManagedChatMessage[]
}

async function setup(sharedHistory?: SharedHistory, memoryContext = '') {
  let current = codexSession()
  const children: FakeChild[] = []
  const launches: Array<{ command: string; args: string[]; child: FakeChild }> = []
  const events: AgentEvent[] = []
  const manager = await ChatManager.create({
    approvalToken: 'secret',
    getSession: (id) => (id === current.id ? current : null),
    bindNativeSession: (_id, nativeSessionId) => {
      current = { ...current, nativeSessionId }
      return current
    },
    ...(sharedHistory
      ? {
          listChatHistory: () => [...sharedHistory.messages],
          appendChatMessage: (
            _id: string,
            message: Omit<ManagedChatMessage, 'id' | 'createdAt' | 'updatedAt'>
          ) => {
            const now = new Date().toISOString()
            const created = {
              ...message,
              id: `message-${sharedHistory.messages.length + 1}`,
              createdAt: now,
              updatedAt: now
            }
            sharedHistory.messages.push(created)
            return created
          },
          updateChatMessage: (
            _id: string,
            messageId: string,
            patch: { text?: string; status?: ManagedChatMessageStatus }
          ) => {
            const index = sharedHistory.messages.findIndex(
              (message) => message.id === messageId
            )
            if (index === -1) return null
            sharedHistory.messages[index] = {
              ...sharedHistory.messages[index],
              ...patch,
              updatedAt: new Date().toISOString()
            }
            return sharedHistory.messages[index]
          }
        }
      : {}),
    getAdapter,
    getProviderEnv: () => ({}),
    getProviderModel: () => undefined,
    ...(memoryContext
      ? { memoryContext: () => ({ text: memoryContext, referencedMemories: [] }) }
      : {}),
    spawn: (command, args) => {
      const child = new FakeChild()
      children.push(child)
      launches.push({ command, args, child })
      return child
    },
    emit: (_sessionId, event) => events.push(event)
  })
  managers.push(manager)
  return { manager, children, launches, events, session: () => current }
}

const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

describe('ChatManager · codex (non-resume adapter, SPEC-019)', () => {
  it('在首回合保持真实任务在前，并将长期记忆放入版本化上下文信封', async () => {
    const { manager, launches } = await setup(undefined, '# Agent OS 长期记忆\n\n- 已确认约束')
    await manager.sendTurn('session-1', '第一问')

    expect(launches[0]?.child.stdin.data).toBe(
      '<agent-os-task version="1">\n第一问\n</agent-os-task>\n\n<agent-os-context version="1">\n# Agent OS 长期记忆\n\n- 已确认约束\n</agent-os-context>'
    )
  })

  it('delivers the prompt via stdin, binds session, and never resumes', async () => {
    const { manager, children, launches, events, session: current } = await setup()
    await manager.sendTurn('session-1', '第一问')

    expect(launches[0]?.command).toBe('codex')
    expect(launches[0]?.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true'
    ])
    expect(launches[0]?.args).not.toContain('--resume')
    expect(launches[0]?.child.stdin.data).toBe('第一问')

    children[0]?.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'th_1' })}\n`)
    children[0]?.stdout.write(
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '第一答' } })}\n`
    )
    children[0]?.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
    children[0]?.finish(0)
    await wait()

    expect(current().nativeSessionId).toBe('th_1')
    expect(events).toContainEqual({ kind: 'text-delta', text: '第一答' })
    expect(manager.state('session-1').status).toBe('idle')
    expect(events.some((e) => e.kind === 'permission-request')).toBe(false)
  })

  it('injects prior transcript into the next turn prompt for multi-turn continuity', async () => {
    const { manager, children, launches } = await setup()
    await manager.sendTurn('session-1', '第一问')
    children[0]?.stdout.write(
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '第一答' } })}\n`
    )
    children[0]?.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
    children[0]?.finish(0)
    await wait()

    await manager.sendTurn('session-1', '第二问')
    expect(launches[1]?.child.stdin.data).toBe(
      '## user\n\n第一问\n\n## assistant\n\n第一答\n\n## user\n\n第二问'
    )
  })

  it('restores managed transcript after the chat manager restarts', async () => {
    const sharedHistory: SharedHistory = { messages: [] }
    const first = await setup(sharedHistory)
    await first.manager.sendTurn('session-1', '第一问')
    first.children[0]?.stdout.write(
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '第一答' } })}\n`
    )
    first.children[0]?.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
    first.children[0]?.finish(0)
    await wait()
    await first.manager.close()
    managers.splice(managers.indexOf(first.manager), 1)

    const second = await setup(sharedHistory)
    await second.manager.sendTurn('session-1', '第二问')

    expect(second.launches[0]?.child.stdin.data).toBe(
      '## user\n\n第一问\n\n## assistant\n\n第一答\n\n## user\n\n第二问'
    )
  })
})
