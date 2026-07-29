import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSessionRepository } from '../src/main/domains/sessions/file-repository'

const tempDirs: string[] = []

function repo(): FileSessionRepository {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-relay-repo-'))
  tempDirs.push(dir)
  return new FileSessionRepository(join(dir, 'sessions.json'))
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('FileSessionRepository relay metadata', () => {
  it('persists relay refs through updateSession and reload', () => {
    const first = repo()
    const source = first.createSession({
      name: '登录问题修复',
      toolId: 'codex',
      workspacePath: '/repo',
      surface: 'chat'
    })
    const target = first.createSession({
      name: '登录问题修复 / Claude 接力',
      toolId: 'claude',
      workspacePath: '/repo',
      surface: 'chat',
      rootTitle: '登录问题修复',
      relaySource: {
        linkId: 'relay-1',
        sessionId: source.id,
        toolId: source.toolId,
        title: source.name,
        contextPackPath: '/repo/.agent-os/relay-context-relay-1.md'
      }
    })

    first.updateSession(source.id, {
      relayTarget: {
        linkId: 'relay-1',
        sessionId: target.id,
        toolId: target.toolId,
        title: target.name,
        contextPackPath: '/repo/.agent-os/relay-context-relay-1.md'
      },
      rootTitle: '登录问题修复'
    })

    const second = new FileSessionRepository(join(tempDirs[0], 'sessions.json'))
    expect(second.getSession(target.id)?.relaySource?.sessionId).toBe(source.id)
    expect(second.getSession(source.id)?.relayTarget?.sessionId).toBe(target.id)
    expect(second.getSession(target.id)?.rootTitle).toBe('登录问题修复')
  })
})
