import { describe, expect, it } from 'vitest'
import type { RelayTarget, StartRelayPayload, WorkbenchSession } from '../src/shared/types'

describe('relay shared contracts', () => {
  it('allows sessions to carry source and target relay refs', () => {
    const session: WorkbenchSession = {
      id: 'target',
      name: '登录问题修复 / Claude 接力',
      toolId: 'claude',
      workspacePath: '/repo',
      terminalSessionId: null,
      nativeSessionId: null,
      surface: 'chat',
      permissionPreset: 'safe',
      favorite: false,
      pinned: false,
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      relaySource: {
        linkId: 'relay-1',
        sessionId: 'source',
        toolId: 'codex',
        title: '登录问题修复',
        contextPackPath: '/repo/.agent-os/relay-context-relay-1.md'
      }
    }

    expect(session.relaySource?.toolId).toBe('codex')
  })

  it('describes a one-click relay request', () => {
    const payload: StartRelayPayload = {
      sourceSessionId: 'source',
      sourceSurface: 'chat',
      targetToolId: 'claude'
    }

    expect(payload.targetToolId).toBe('claude')
  })

  it('distinguishes unavailable relay targets from available ones', () => {
    const target: RelayTarget = {
      toolId: 'opencode',
      displayName: 'OpenCode',
      availability: 'not-authenticated',
      reason: '未登录'
    }

    expect(target.availability).toBe('not-authenticated')
  })
})
