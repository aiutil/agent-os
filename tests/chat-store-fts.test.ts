import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatSqliteStore } from '../src/main/domains/sessions/chat-sqlite-store'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function newPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-chat-fts-'))
  tempDirs.push(dir)
  return join(dir, 'chat.sqlite')
}

function ftsCount(path: string): number {
  const raw = new Database(path)
  try {
    return (raw.prepare('SELECT COUNT(*) AS c FROM chat_messages_fts').get() as { c: number }).c
  } finally {
    raw.close()
  }
}

describe('ChatSqliteStore FTS search', () => {
  it('finds appended messages via FTS and reflects text updates', () => {
    const store = new ChatSqliteStore(newPath())
    try {
      const m = store.appendMessage('s1', { role: 'user', text: '重构搜索索引架构', status: 'completed' })
      expect(store.searchSessions('重构搜索', 10)).toHaveLength(1)

      store.updateMessage('s1', m.id, { text: '登录流程排查问题' })
      expect(store.searchSessions('重构搜索', 10)).toEqual([])
      expect(store.searchSessions('登录流程', 10)).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('matches multi-term (AND) queries', () => {
    const store = new ChatSqliteStore(newPath())
    try {
      store.appendMessage('s1', { role: 'user', text: 'deploy the CMP module to staging', status: 'completed' })
      store.appendMessage('s2', { role: 'user', text: 'deploy the WEB module', status: 'completed' })
      const hits = store.searchSessions('deploy CMP', 10)
      expect(hits.map((h) => h.sessionId)).toEqual(['s1'])
    } finally {
      store.close()
    }
  })

  it('falls back to LIKE for short CJK (<3 char) queries', () => {
    const store = new ChatSqliteStore(newPath())
    try {
      store.appendMessage('s2', { role: 'user', text: '登录失败排查', status: 'completed' })
      const hits = store.searchSessions('登录', 10)
      expect(hits.map((h) => h.sessionId)).toContain('s2')
    } finally {
      store.close()
    }
  })

  it('cleans FTS rows when a session is deleted (cascade trigger, no orphans)', () => {
    const path = newPath()
    const store = new ChatSqliteStore(path)
    store.appendMessage('s1', { role: 'user', text: 'orphan check content here', status: 'completed' })
    store.close()

    expect(ftsCount(path)).toBe(1)

    const raw = new Database(path)
    raw.pragma('foreign_keys = ON')
    raw.prepare('DELETE FROM chat_sessions WHERE id = ?').run('s1')
    raw.close()

    expect(ftsCount(path)).toBe(0)
  })

  it('backfills FTS for pre-existing messages when migrating v1 -> v2', () => {
    const path = newPath()
    // 构造一个没有 FTS 的旧库（user_version = 1）。
    const raw = new Database(path)
    raw.pragma('user_version = 1')
    raw.exec(`
      CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        role TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    raw.prepare('INSERT INTO chat_sessions VALUES (?,?,?)').run('s1', '2026-01-01', '2026-01-01')
    raw
      .prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?,?)')
      .run('m1', 's1', 'user', 'backfilltoken legacy content', 'completed', '2026-01-01', '2026-01-01')
    raw.close()

    const store = new ChatSqliteStore(path)
    try {
      expect(store.searchSessions('backfilltoken', 10)).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})
