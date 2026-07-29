import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAdapter } from '../src/main/domains/adapters/registry'
import type { CliAdapter } from '../src/main/domains/adapters/types'
import { ChatManager } from '../src/main/domains/chat/manager'
import type { AgentEvent, WorkbenchSession } from '../src/shared/types'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for mock Claude')
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

describe('chat control-channel integration', () => {
  it('runs a synthetic Claude subprocess through defer, resume, and allow', async () => {
    let session: WorkbenchSession = {
      id: 'integration-session',
      name: 'Mock chat',
      toolId: 'claude',
      workspacePath: '/tmp',
      terminalSessionId: null,
      nativeSessionId: null,
      surface: 'chat',
      permissionPreset: 'safe',
      favorite: false,
      pinned: false,
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z'
    }
    const events: AgentEvent[] = []
    const claude = getAdapter('claude')!
    const mockAdapter: CliAdapter = {
      ...claude,
      headlessJson: {
        ...claude.headlessJson!,
        buildTurn(input) {
          const launch = claude.headlessJson!.buildTurn(input)
          return {
            ...launch,
            command: process.execPath,
            args: [resolve('tests/fixtures/control/mock-claude.cjs'), ...launch.args]
          }
        }
      }
    }
    const manager = await ChatManager.create({
      approvalToken: 'integration-secret',
      getSession: (id) => (id === session.id ? session : null),
      bindNativeSession: (_id, nativeSessionId) => {
        session = { ...session, nativeSessionId }
        return session
      },
      getAdapter: (toolId) => (toolId === 'claude' ? mockAdapter : undefined),
      getProviderEnv: () => ({}),
      getProviderModel: () => undefined,
      emit: (_sessionId, event) => events.push(event)
    })

    try {
      await manager.sendTurn(session.id, 'edit the fixture')
      await waitFor(() => manager.state(session.id).status === 'awaiting-permission')
      const permission = events.find(
        (event): event is Extract<AgentEvent, { kind: 'permission-request' }> =>
          event.kind === 'permission-request'
      )
      expect(permission?.toolName).toBe('Edit')

      await manager.respondPermission(session.id, permission!.requestId, 'once')
      await waitFor(() => manager.state(session.id).status === 'idle')

      expect(session.nativeSessionId).toBe('mock-native-session')
      expect(events).toContainEqual({
        kind: 'tool-result',
        toolUseId: 'mock-edit-1',
        content: 'updated',
        isError: false
      })
      expect(events).toContainEqual({ kind: 'text-delta', text: '完成' })
      expect(events).toContainEqual({
        kind: 'turn-end',
        status: 'completed',
        costUsd: 0
      })
    } finally {
      await manager.close()
    }
  })
})
