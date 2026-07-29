// SPEC-035：codex readMeta 必须跳过注入的前导 user 记录（AGENTS.md 指令 / environment_context），
// 取第一条真正用户键入的消息作为标题。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexSessionStorage } from '../src/main/domains/adapters/codex/storage'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function userRecord(text: string): string {
  return JSON.stringify({
    timestamp: '2026-03-20T06:56:46.272Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
  })
}

function writeSession(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-title-'))
  tempDirs.push(dir)
  const file = join(dir, 'rollout.jsonl')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

describe('codex readMeta title (SPEC-035)', () => {
  it('skips AGENTS.md instructions + environment_context, picks the real prompt', async () => {
    const file = writeSession([
      JSON.stringify({
        timestamp: '2026-03-20T06:56:45Z',
        type: 'session_meta',
        payload: { id: 'codex-sess-1', cwd: '/work/proj', timestamp: '2026-03-20T06:56:45Z' }
      }),
      userRecord('# AGENTS.md instructions for /Users/x/.config\n\n<INSTRUCTIONS>\nsome skill list\n</INSTRUCTIONS>'),
      userRecord('<environment_context>\ncwd=/work/proj os=macos\n</environment_context>'),
      userRecord('say hello'),
      userRecord('and now do real work')
    ])
    const meta = await codexSessionStorage.readMeta!(file)
    expect(meta.title).toBe('say hello')
    expect(meta.nativeSessionId).toBe('codex-sess-1')
  })

  it('falls back to filename when only injected context exists', async () => {
    const file = writeSession([
      JSON.stringify({
        timestamp: '2026-03-20T06:56:45Z',
        type: 'session_meta',
        payload: { id: 'codex-sess-2', cwd: '/work/proj' }
      }),
      userRecord('# AGENTS.md instructions for /x'),
      userRecord('<environment_context>cwd=/x</environment_context>')
    ])
    const meta = await codexSessionStorage.readMeta!(file)
    // 无真实用户消息 → 回落文件名（fallbackTitle），不取注入内容、不空标题。
    expect(meta.title).not.toContain('AGENTS.md')
    expect(meta.title.length).toBeGreaterThan(0)
  })
})
