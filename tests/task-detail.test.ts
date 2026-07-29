import { describe, expect, it } from 'vitest'
import {
  findTaskSessionView,
  taskDeliveriesForRun,
  taskMessagesForRun,
  taskTimelineForRun
} from '../src/shared/task-detail'
import type {
  ManagedChatMessage,
  ManagedChatTimelineItem,
  TaskRun,
  WorkbenchSessionView
} from '../src/shared/types'

const run: TaskRun = {
  id: 'run-2',
  taskId: 'task-1',
  trigger: 'schedule',
  status: 'succeeded',
  sessionId: 'session-1',
  startedAt: '2026-07-19T01:00:00.000Z',
  finishedAt: '2026-07-19T01:01:00.000Z'
}

function message(
  id: string,
  role: ManagedChatMessage['role'],
  text: string,
  createdAt: string
): ManagedChatMessage {
  return { id, role, text, status: 'completed', createdAt, updatedAt: createdAt }
}

function timeline(
  id: string,
  seq: number,
  type: ManagedChatTimelineItem['type'],
  createdAt: string,
  content?: string
): ManagedChatTimelineItem {
  return { id, sessionId: 'session-1', turnId: 'turn-1', seq, type, createdAt, content }
}

describe('task detail projection', () => {
  it('resolves an existing task session by managed session id only', () => {
    const view = {
      id: 'managed-session',
      nativeSessionId: 'native-session'
    } as unknown as WorkbenchSessionView

    expect(findTaskSessionView('managed-session', [view])).toBe(view)
    expect(findTaskSessionView('native-session', [view])).toBeNull()
  })

  it('scopes continued-session messages to the selected task run', () => {
    const messages = [
      message('old', 'assistant', '上一轮交付', '2026-07-19T00:50:00.000Z'),
      message('prompt', 'user', '本轮任务', '2026-07-19T01:00:01.000Z'),
      message('delivery', 'assistant', '本轮交付', '2026-07-19T01:00:59.000Z'),
      message('next', 'assistant', '下一轮交付', '2026-07-19T01:10:00.000Z')
    ]

    expect(taskMessagesForRun(run, messages).map((item) => item.id)).toEqual(['prompt', 'delivery'])
    expect(taskDeliveriesForRun(run, messages, [])[0]?.text).toBe('本轮交付')
  })

  it('orders timeline events by sequence and ignores another session', () => {
    const items = [
      timeline('tool-result', 3, 'tool_result', '2026-07-19T01:00:04.000Z'),
      timeline('thinking', 1, 'thinking', '2026-07-19T01:00:02.000Z'),
      { ...timeline('other', 2, 'text', '2026-07-19T01:00:03.000Z'), sessionId: 'session-2' },
      timeline('tool-use', 2, 'tool_use', '2026-07-19T01:00:03.000Z')
    ]

    expect(taskTimelineForRun(run, items).map((item) => item.id)).toEqual([
      'thinking',
      'tool-use',
      'tool-result'
    ])
  })

  it('coalesces adjacent thinking and text deltas without inserting whitespace', () => {
    const items = [
      timeline('thinking-2', 2, 'thinking', '2026-07-19T01:00:03.000Z', '完成的 ISSUE。'),
      timeline('thinking-1', 1, 'thinking', '2026-07-19T01:00:02.000Z', '分析本项目未'),
      timeline('text-1', 3, 'text', '2026-07-19T01:00:04.000Z', '分析'),
      timeline('text-2', 4, 'text', '2026-07-19T01:00:05.000Z', '完成')
    ]

    expect(taskTimelineForRun(run, items)).toEqual([
      expect.objectContaining({ id: 'thinking-1', content: '分析本项目未完成的 ISSUE。' }),
      expect.objectContaining({ id: 'text-1', content: '分析完成' })
    ])
  })

  it('keeps tool and turn boundaries between thinking streams', () => {
    const items = [
      timeline('thinking-before-tool', 1, 'thinking', '2026-07-19T01:00:02.000Z', '准备'),
      timeline('tool-use', 2, 'tool_use', '2026-07-19T01:00:03.000Z'),
      timeline('thinking-after-tool', 3, 'thinking', '2026-07-19T01:00:04.000Z', '继续'),
      {
        ...timeline('thinking-next-turn', 4, 'thinking', '2026-07-19T01:00:05.000Z', '新回合'),
        turnId: 'turn-2'
      }
    ]

    expect(taskTimelineForRun(run, items).map((item) => item.id)).toEqual([
      'thinking-before-tool',
      'tool-use',
      'thinking-after-tool',
      'thinking-next-turn'
    ])
  })

  it('falls back to the complete coalesced text stream when managed history is unavailable', () => {
    const items = [
      timeline('draft', 1, 'text', '2026-07-19T01:00:10.000Z', '处理中'),
      timeline('final', 2, 'text', '2026-07-19T01:00:50.000Z', '最终交付')
    ]

    expect(taskDeliveriesForRun(run, [], items)).toEqual([
      expect.objectContaining({ id: 'draft', text: '处理中最终交付', source: 'timeline' })
    ])
  })
})
