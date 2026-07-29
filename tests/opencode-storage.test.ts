import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listOpenCodeSessions,
  scanOpenCodeTranscripts
} from '../src/main/domains/adapters/opencode/storage'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('OpenCode transcript snapshots', () => {
  it('从 SQLite 会话、消息与 part 还原真实角色和时间', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-opencode-'))
    tempDirs.push(dir)
    const path = join(dir, 'opencode.db')
    const db = new Database(path)
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, directory TEXT, title TEXT,
        time_created INTEGER, time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
        time_created INTEGER, data TEXT
      );
    `)
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      'ses_test',
      '/workspace/opencode',
      'OpenCode 测试',
      1_780_000_000_000,
      1_780_000_060_000
    )
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      'msg_user',
      'ses_test',
      1_780_000_001_000,
      JSON.stringify({ role: 'user', time: { created: 1_780_000_001_000 } })
    )
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
      'part_text',
      'msg_user',
      'ses_test',
      1_780_000_001_000,
      JSON.stringify({ type: 'text', text: '真实用户提示' })
    )
    db.close()

    const transcripts = []
    for await (const transcript of scanOpenCodeTranscripts(path)) transcripts.push(transcript)

    expect(transcripts).toHaveLength(1)
    expect(transcripts[0]).toMatchObject({
      nativeSessionId: 'ses_test',
      toolId: 'opencode',
      cwd: '/workspace/opencode',
      title: 'OpenCode 测试'
    })
    expect(transcripts[0].messages).toMatchObject([
      { role: 'user', text: '真实用户提示' }
    ])
    expect(transcripts[0].messages[0].ts).toBe(new Date(1_780_000_001_000).toISOString())
    expect(listOpenCodeSessions(path)).toEqual([
      {
        path: `${path}#ses_test`,
        nativeSessionId: 'ses_test',
        toolId: 'opencode',
        cwd: '/workspace/opencode',
        createdAt: 1_780_000_000_000,
        mtime: 1_780_000_060_000
      }
    ])
  })
})
