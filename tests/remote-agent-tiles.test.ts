import { describe, expect, it } from 'vitest'
import { buildRemoteAgentTiles } from '../src/shared/remote-agent-tiles'
import type { NodeAgentInfo } from '../src/shared/types'

describe('remote node agent tiles', () => {
  it('only includes agents reported by the remote node', () => {
    const agents: NodeAgentInfo[] = [
      { id: 'opencode', name: 'OpenCode', version: '1.17.11', enabled: true }
    ]
    const catalog = [
      { toolId: 'claude', displayName: 'Claude' },
      { toolId: 'codex', displayName: 'Codex' },
      { toolId: 'opencode', displayName: 'OpenCode' },
      { toolId: 'shell', displayName: 'Shell' }
    ]

    expect(buildRemoteAgentTiles(agents, catalog)).toEqual([
      { toolId: 'opencode', displayName: 'OpenCode' }
    ])
  })
})
