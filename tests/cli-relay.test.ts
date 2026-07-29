import { describe, expect, it } from 'vitest'
import { createAgentOsCli } from '../src/main/cli'
import type { RelayTarget, StartRelayPayload, StartRelayResult } from '../src/shared/types'

function setup() {
  const calls: StartRelayPayload[] = []
  const cli = createAgentOsCli({
    startRelay: async (payload) => {
      calls.push(payload)
      return { targetSessionId: 'target-1', relayLinkId: 'relay-1' }
    },
    listRelayTargets: async () => [
      {
        toolId: 'claude',
        displayName: 'Claude Code',
        availability: 'available'
      }
    ],
    close: async () => undefined
  })
  return { cli, calls }
}

describe('agent-os CLI relay', () => {
  it('starts a relay from the command line and prints a desktop deep link as JSON', async () => {
    const { cli, calls } = setup()

    const result = await cli.run(['relay', '--from', 'source-1', '--to', 'claude', '--json'])

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      {
        sourceSessionId: 'source-1',
        sourceSurface: 'cli',
        targetToolId: 'claude'
      }
    ])
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      targetSessionId: 'target-1',
      relayLinkId: 'relay-1',
      openUrl: 'agentos://session/target-1'
    })
  })

  it('does not start relay when required arguments are missing', async () => {
    const { cli, calls } = setup()

    const result = await cli.run(['relay', '--from', 'source-1'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('缺少 --to <toolId>')
    expect(calls).toEqual([])
  })

  it('lists relay targets for scriptable agent selection', async () => {
    const cli = createAgentOsCli({
      startRelay: async (): Promise<StartRelayResult> => {
        throw new Error('should not relay')
      },
      listRelayTargets: async (sourceSessionId): Promise<RelayTarget[]> => [
        {
          toolId: sourceSessionId === 'source-1' ? 'claude' : 'codex',
          displayName: 'Claude Code',
          availability: 'available'
        }
      ],
      close: async () => undefined
    })

    const result = await cli.run(['relay-targets', '--from', 'source-1', '--json'])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      {
        toolId: 'claude',
        displayName: 'Claude Code',
        availability: 'available'
      }
    ])
  })
})
