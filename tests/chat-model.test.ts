import { describe, expect, it } from 'vitest'
import {
  appendUserMessage,
  applyAgentEvent,
  processStatusText,
  transcriptItems,
  transcriptHistoryItems,
  timelineItems,
  upsertTimelineItem,
  type ChatItem
} from '../src/renderer/src/pages/workbench/chat-model'

describe('chat view model', () => {
  it('coalesces text deltas into one assistant message', () => {
    let items: ChatItem[] = []
    items = appendUserMessage(items, 'hello', 'user-1')
    items = applyAgentEvent(items, { kind: 'text-delta', text: '你' }, 'event-1')
    items = applyAgentEvent(items, { kind: 'text-delta', text: '好' }, 'event-2')

    expect(items).toEqual([
      { id: 'user-1', kind: 'message', role: 'user', text: 'hello' },
      {
        id: 'event-1',
        kind: 'message',
        role: 'assistant',
        text: '你好'
      }
    ])
  })

  it('updates a tool card and keeps permission requests actionable', () => {
    let items: ChatItem[] = applyAgentEvent(
      [],
      {
        kind: 'tool-start',
        toolUseId: 'tool-1',
        toolName: 'Edit',
        input: { file_path: '/tmp/a.ts' }
      },
      'event-1'
    )
    items = applyAgentEvent(
      items,
      {
        kind: 'tool-result',
        toolUseId: 'tool-1',
        content: 'updated',
        isError: false
      },
      'event-2'
    )
    items = applyAgentEvent(
      items,
      {
        kind: 'permission-request',
        requestId: 'request-1',
        toolName: 'Bash',
        input: { command: 'npm test' },
        suggestions: []
      },
      'event-3'
    )

    expect(items).toEqual([
      {
        id: 'event-1',
        kind: 'tool',
        toolUseId: 'tool-1',
        toolName: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        result: 'updated',
        isError: false
      },
      {
        id: 'event-3',
        kind: 'permission',
        requestId: 'request-1',
        toolName: 'Bash',
        input: { command: 'npm test' }
      }
    ])
  })

  it('coalesces thinking deltas into one thinking item', () => {
    let items: ChatItem[] = []
    items = applyAgentEvent(items, { kind: 'thinking-delta', text: '分析' }, 'think-1')
    items = applyAgentEvent(items, { kind: 'thinking-delta', text: '问题' }, 'think-2')
    items = applyAgentEvent(items, { kind: 'text-delta', text: '答案' }, 'text-1')

    expect(items).toEqual([
      { id: 'think-1', kind: 'thinking', text: '分析问题' },
      { id: 'text-1', kind: 'message', role: 'assistant', text: '答案' }
    ])
  })

  it('preserves unknown event payloads for an expandable fallback card', () => {
    expect(
      applyAgentEvent(
        [],
        {
          kind: 'unknown',
          rawType: 'future_event',
          payload: { value: 1 }
        },
        'event-1'
      )
    ).toEqual([
      {
        id: 'event-1',
        kind: 'unknown',
        rawType: 'future_event',
        payload: { value: 1 }
      }
    ])
  })

  it('groups persisted timeline into a folded process and final assistant text', () => {
    const items = timelineItems(
      [
        {
          id: 'message-user',
          role: 'user',
          text: '检查测试',
          status: 'completed',
          createdAt: '2026-06-17T00:00:00.000Z',
          updatedAt: '2026-06-17T00:00:00.000Z'
        }
      ],
      [
        {
          id: 'timeline-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          seq: 1,
          type: 'thinking',
          content: '先看上下文',
          createdAt: '2026-06-17T00:00:01.000Z'
        },
        {
          id: 'timeline-2',
          sessionId: 'session-1',
          turnId: 'turn-1',
          seq: 2,
          type: 'tool_use',
          tool: 'Bash',
          toolUseId: 'tool-1',
          input: { command: 'npm test' },
          createdAt: '2026-06-17T00:00:02.000Z'
        },
        {
          id: 'timeline-3',
          sessionId: 'session-1',
          turnId: 'turn-1',
          seq: 3,
          type: 'tool_result',
          toolUseId: 'tool-1',
          output: 'ok',
          isError: false,
          createdAt: '2026-06-17T00:00:03.000Z'
        },
        {
          id: 'timeline-4',
          sessionId: 'session-1',
          turnId: 'turn-1',
          seq: 4,
          type: 'text',
          content: '测试通过',
          createdAt: '2026-06-17T00:00:04.000Z'
        }
      ],
      'idle'
    )

    expect(items).toMatchObject([
      { kind: 'message', role: 'user', text: '检查测试' },
      {
        kind: 'process',
        turnId: 'turn-1',
        status: 'completed',
        defaultOpen: false,
        steps: [
          { kind: 'thinking', detail: '先看上下文' },
          { kind: 'tool', title: '正在运行命令', detail: 'npm test', output: 'ok' }
        ]
      },
      { kind: 'message', role: 'assistant', text: '测试通过' }
    ])
  })

  it('interleaves multiple turns in chronological order', () => {
    const items = timelineItems(
      [
        {
          id: 'user-1',
          role: 'user',
          text: '一问',
          status: 'completed',
          createdAt: '2026-06-17T00:00:00.000Z',
          updatedAt: '2026-06-17T00:00:00.000Z'
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: '一答',
          status: 'completed',
          createdAt: '2026-06-17T00:00:01.000Z',
          updatedAt: '2026-06-17T00:00:01.000Z'
        },
        {
          id: 'user-2',
          role: 'user',
          text: '二问',
          status: 'completed',
          createdAt: '2026-06-17T00:00:10.000Z',
          updatedAt: '2026-06-17T00:00:10.000Z'
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          text: '二答',
          status: 'completed',
          createdAt: '2026-06-17T00:00:11.000Z',
          updatedAt: '2026-06-17T00:00:11.000Z'
        }
      ],
      [
        {
          id: 't-1',
          sessionId: 's',
          turnId: 'turn-1',
          seq: 1,
          type: 'text',
          content: '一答',
          createdAt: '2026-06-17T00:00:00.500Z'
        },
        {
          id: 't-2',
          sessionId: 's',
          turnId: 'turn-2',
          seq: 2,
          type: 'text',
          content: '二答',
          createdAt: '2026-06-17T00:00:10.500Z'
        }
      ],
      'idle'
    )

    const texts = items.filter((i) => i.kind === 'message').map((i) => i.text)
    expect(texts).toEqual(['一问', '一答', '二问', '二答'])
  })

  it('keeps each user message above its own answer even when an orphan user lacks a turn', () => {
    // 复现 Bug：一个没有 turn 的孤儿 user（如被 turnInProgress 拒绝后残留的乐观消息）
    // 处在两条合法提问中间。旧实现按下标把孤儿配给后面的 turn，导致真正的提问者被
    // 「尾部兜底」沉到自己回答的下方。新实现按 createdAt 合并排序，每条 user 都落在
    // 自己的时间位、位于其回答之前。
    const items = timelineItems(
      [
        {
          id: 'user-a',
          role: 'user',
          text: 'A 问',
          status: 'completed',
          createdAt: '2026-06-17T00:00:00.000Z',
          updatedAt: '2026-06-17T00:00:00.000Z'
        },
        {
          id: 'user-orphan',
          role: 'user',
          text: '孤儿提问',
          status: 'completed',
          createdAt: '2026-06-17T00:00:05.000Z',
          updatedAt: '2026-06-17T00:00:05.000Z'
        },
        {
          id: 'user-b',
          role: 'user',
          text: 'B 问',
          status: 'completed',
          createdAt: '2026-06-17T00:00:10.000Z',
          updatedAt: '2026-06-17T00:00:10.000Z'
        }
      ],
      [
        {
          id: 't-a',
          sessionId: 's',
          turnId: 'turn-a',
          seq: 1,
          type: 'text',
          content: 'A 答',
          createdAt: '2026-06-17T00:00:00.500Z'
        },
        {
          id: 't-b',
          sessionId: 's',
          turnId: 'turn-b',
          seq: 2,
          type: 'text',
          content: 'B 答',
          createdAt: '2026-06-17T00:00:10.500Z'
        }
      ],
      'idle'
    )

    // A 问 / A 答 / 孤儿提问 / B 问 / B 答 —— B 问必须出现在 B 答之前（旧实现会把 B 问沉到 B 答之后）
    const texts = items.filter((i) => i.kind === 'message').map((i) => i.text)
    expect(texts).toEqual(['A 问', 'A 答', '孤儿提问', 'B 问', 'B 答'])
  })

  it('sorts timeline updates and derives specific running status', () => {
    const timeline = upsertTimelineItem(
      [
        {
          id: 'timeline-2',
          sessionId: 'session-1',
          turnId: 'turn-1',
          seq: 2,
          type: 'text',
          content: 'done',
          createdAt: '2026-06-17T00:00:02.000Z'
        }
      ],
      {
        id: 'timeline-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        seq: 1,
        type: 'tool_use',
        tool: 'Grep',
        toolUseId: 'tool-1',
        input: { pattern: 'ChatManager' },
        createdAt: '2026-06-17T00:00:01.000Z'
      }
    )

    expect(timeline.map((item) => item.id)).toEqual(['timeline-1', 'timeline-2'])
    expect(processStatusText([timeline[0]], 'running')).toBe('正在搜索代码')
  })

  it('normalizes closed transcript history into readable chat details', () => {
    const items = transcriptHistoryItems([
      {
        seq: 1,
        role: 'user',
        text: '<local-command-caveat>Caveat</local-command-caveat>',
        raw: { kind: 'text' }
      },
      {
        seq: 2,
        role: 'system',
        text: '[unsupported: model]',
        raw: { kind: 'model' }
      },
      {
        seq: 3,
        role: 'user',
        text: '<command-name>/model</command-name>\n<command-message>model</command-message>',
        raw: { kind: 'text' }
      },
      {
        seq: 4,
        role: 'tool',
        text: '<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>',
        raw: { kind: 'tool_result' }
      },
      {
        seq: 5,
        role: 'user',
        text: 'hi',
        raw: { kind: 'text' }
      },
      {
        seq: 6,
        role: 'assistant',
        text: 'Hey! What can I help you with?',
        raw: { kind: 'text' }
      }
    ])

    expect(items).toMatchObject([
      {
        kind: 'process',
        title: '历史过程',
        defaultOpen: false,
        steps: [
          { kind: 'tool', title: '本地命令 /model', detail: 'model' },
          { kind: 'tool', title: '本地命令输出', output: 'Set model to Haiku 4.5' }
        ]
      },
      { kind: 'message', role: 'user', text: 'hi' },
      { kind: 'message', role: 'assistant', text: 'Hey! What can I help you with?' }
    ])
  })

  it('folds transcript process records for active chat fallback', () => {
    const items = transcriptItems([
      {
        seq: 1,
        role: 'assistant',
        text: '先检查上下文',
        raw: { kind: 'thinking' }
      },
      {
        seq: 2,
        role: 'tool',
        text: '[tool: Read] {"file_path":"README.md"}',
        toolName: 'Read',
        raw: { kind: 'tool_use' }
      },
      {
        seq: 3,
        role: 'assistant',
        text: '主要结论',
        raw: { kind: 'text' }
      }
    ])

    expect(items).toMatchObject([
      {
        kind: 'process',
        defaultOpen: false,
        steps: [
          { kind: 'thinking', detail: '先检查上下文' },
          { kind: 'tool', title: '工具调用 Read', detail: '[tool: Read] {"file_path":"README.md"}' }
        ]
      },
      { kind: 'message', role: 'assistant', text: '主要结论' }
    ])
  })
})
