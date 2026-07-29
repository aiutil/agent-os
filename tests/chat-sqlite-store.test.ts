import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatSqliteStore } from '../src/main/domains/sessions/chat-sqlite-store'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createStore(): ChatSqliteStore {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-chat-store-'))
  tempDirs.push(dir)
  return new ChatSqliteStore(join(dir, 'chat.sqlite'))
}

describe('ChatSqliteStore', () => {
  it('persists managed chat messages and marks streaming messages interrupted', () => {
    const store = createStore()
    try {
      const user = store.appendMessage('session-1', {
        role: 'user',
        text: 'hello',
        status: 'completed'
      })
      const assistant = store.appendMessage('session-1', {
        role: 'assistant',
        text: 'working',
        status: 'streaming'
      })

      expect(store.listMessages('session-1')).toMatchObject([
        { id: user.id, role: 'user', text: 'hello', status: 'completed' },
        { id: assistant.id, role: 'assistant', text: 'working', status: 'streaming' }
      ])

      store.markInterruptedMessages()
      expect(store.listMessages('session-1')[1]).toMatchObject({ status: 'interrupted' })
    } finally {
      store.close()
    }
  })

  it('searches message content across sessions and lists recent on empty query', () => {
    const store = createStore()
    try {
      store.appendMessage('s-a', { role: 'user', text: 'deploy the CMP project module', status: 'completed' })
      store.appendMessage('s-a', { role: 'assistant', text: 'done', status: 'completed' })
      store.appendMessage('s-b', { role: 'user', text: 'unrelated chat', status: 'completed' })

      // ASCII LIKE 默认不区分大小写：小写 query 命中大写正文。
      const hits = store.searchSessions('cmp', 10)
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({ sessionId: 's-a', messageCount: 2 })
      expect(hits[0].matchText).toContain('CMP')

      // 空 query 返回各会话最近活动（matchText 为 null）。
      const recent = store.searchSessions('', 10)
      expect(recent.map((r) => r.sessionId).sort()).toEqual(['s-a', 's-b'])
      expect(recent.every((r) => r.matchText === null)).toBe(true)

      expect(store.searchSessions('nothing-here', 10)).toEqual([])
    } finally {
      store.close()
    }
  })

  it('persists timeline items ordered by seq and updates permission status', () => {
    const store = createStore()
    try {
      expect(store.nextSeq('session-1')).toBe(1)
      store.appendTimelineItem({
        sessionId: 'session-1',
        turnId: 'turn-1',
        seq: 2,
        type: 'text',
        content: 'done'
      })
      store.appendTimelineItem({
        sessionId: 'session-1',
        turnId: 'turn-1',
        seq: 1,
        type: 'permission',
        tool: 'Bash',
        toolUseId: 'tool-1',
        input: { command: 'npm test' },
        status: 'pending'
      })

      expect(store.nextSeq('session-1')).toBe(3)
      expect(store.listTimeline('session-1')).toMatchObject([
        {
          seq: 1,
          type: 'permission',
          tool: 'Bash',
          toolUseId: 'tool-1',
          input: { command: 'npm test' },
          status: 'pending'
        },
        { seq: 2, type: 'text', content: 'done' }
      ])

      const updated = store.updatePermissionStatus('session-1', 'turn-1', 'tool-1', 'allowed-once')
      expect(updated).toMatchObject({ status: 'allowed-once' })
      expect(store.listTimeline('session-1')[0]).toMatchObject({ status: 'allowed-once' })
    } finally {
      store.close()
    }
  })

  it('persists queued turns with files in FIFO order and supports cancellation', () => {
    const store = createStore()
    try {
      const second = store.enqueueTurn('session-1', {
        text: 'second prompt',
        files: ['/tmp/b.png']
      })
      const first = store.enqueueTurn('session-1', {
        text: 'first prompt',
        files: ['/tmp/a.md', '/tmp/a.png']
      })

      expect(second.files).toEqual(['/tmp/b.png'])
      expect(first.files).toEqual(['/tmp/a.md', '/tmp/a.png'])
      expect(store.listQueuedTurns('session-1').map((turn) => turn.text)).toEqual([
        'second prompt',
        'first prompt'
      ])

      expect(store.cancelQueuedTurn('session-1', second.id)).toBe(true)
      expect(store.cancelQueuedTurn('session-1', second.id)).toBe(false)
      expect(store.listQueuedTurns('session-1')).toMatchObject([
        {
          id: first.id,
          text: 'first prompt',
          files: ['/tmp/a.md', '/tmp/a.png']
        }
      ])
    } finally {
      store.close()
    }
  })
})
