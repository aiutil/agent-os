import { describe, expect, it } from 'vitest'
import { filterUsableDiscoveryResults, filterUsableRuntimes } from '../src/shared/runtime-availability'
import type { DiscoveryResult, RuntimeInfo } from '../src/shared/types'

describe('runtime availability filters', () => {
  it('keeps only discovered CLI results that are actually runnable', () => {
    const base = { displayName: 'Agent', executable: 'agent', supportsChat: true, evidence: [], scanDurationMs: 1 }
    const results: DiscoveryResult[] = [
      { ...base, toolId: 'claude', health: 'ready', executablePath: '/usr/local/bin/claude' },
      { ...base, toolId: 'opencode', health: 'updatable', executablePath: '/usr/local/bin/opencode' },
      { ...base, toolId: 'codex', health: 'missing' },
      { ...base, toolId: 'gemini', health: 'failed' }
    ]

    expect(filterUsableDiscoveryResults(results).map((result) => result.toolId)).toEqual([
      'claude',
      'opencode'
    ])
  })

  it('keeps only usable runtime records reported by a remote node', () => {
    const base: Omit<RuntimeInfo, 'toolId' | 'displayName' | 'health'> = {
      channel: 'pty',
      canResume: true,
      capabilities: {
        terminal: true,
        chat: true,
        terminalResume: true,
        chatContinuation: 'native',
        linkedTerminal: true,
        attachments: { images: true, files: true }
      }
    }
    const runtimes: RuntimeInfo[] = [
      { ...base, toolId: 'claude', displayName: 'Claude', health: 'ready' },
      { ...base, toolId: 'codex', displayName: 'Codex', health: 'missing' }
    ]

    expect(filterUsableRuntimes(runtimes).map((runtime) => runtime.toolId)).toEqual(['claude'])
  })
})
