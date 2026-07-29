import { describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeHost } from '../src/main/domains/runtime/remote-runtime-host'
import type { ChatTurnState, RemoteNode } from '../src/shared/types'

describe('RemoteRuntimeHost steer contract', () => {
  it('delegates steerTurn to the adopted daemon with attachments intact', async () => {
    const state: ChatTurnState = {
      sessionId: 'remote-session',
      turnId: 'remote-steer-turn',
      status: 'running',
      startedAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
      pendingPermission: null,
      error: null,
      queuedCount: 0
    }
    const steerTurn = vi.fn(async () => state)
    const node: RemoteNode = {
      id: 'node-1',
      label: 'Remote node',
      host: '127.0.0.1',
      port: 18421,
      token: 'test-token',
      fingerprint: 'AA:BB',
      addedAt: '2026-07-23T00:00:00.000Z'
    }
    const remote = new RemoteRuntimeHost(node, undefined, { probeTerminal: false })
    ;(
      remote as unknown as {
        daemon: { steerTurn: typeof steerTurn } | null
      }
    ).daemon = { steerTurn }

    await expect(
      remote.steerTurn('remote-session', 'correct course', ['/tmp/context.txt'])
    ).resolves.toEqual(state)
    expect(steerTurn).toHaveBeenCalledWith(
      'remote-session',
      'correct course',
      ['/tmp/context.txt']
    )
  })
})
