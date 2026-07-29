import { describe, expect, it } from 'vitest'
import { buildRelayContextMarkdown, sortRelayTargets } from '../src/main/domains/relay/context'
import { relayTitle } from '../src/main/domains/relay/title'

describe('relay pure helpers', () => {
  it('builds target titles from the root title without stacking suffixes', () => {
    expect(relayTitle('登录问题修复', 'Claude Code')).toBe('登录问题修复 / Claude Code 接力')
    expect(relayTitle('登录问题修复 / Claude Code 接力', 'Gemini', '登录问题修复')).toBe(
      '登录问题修复 / Gemini 接力'
    )
  })

  it('sorts available targets first and then by recent use', () => {
    const sorted = sortRelayTargets([
      { toolId: 'qwen', displayName: 'Qwen', availability: 'not-installed' },
      {
        toolId: 'claude',
        displayName: 'Claude',
        availability: 'available',
        lastUsedAt: '2026-07-02T09:00:00.000Z'
      },
      {
        toolId: 'gemini',
        displayName: 'Gemini',
        availability: 'available',
        lastUsedAt: '2026-07-02T10:00:00.000Z'
      }
    ])

    expect(sorted.map((item) => item.toolId)).toEqual(['gemini', 'claude', 'qwen'])
  })

  it('builds a standard context pack that asks the target agent for a handoff summary', () => {
    const md = buildRelayContextMarkdown({
      sourceTitle: '登录问题修复',
      sourceToolId: 'codex',
      targetToolId: 'claude',
      workspacePath: '/repo',
      sourceSessionId: 'source',
      sourceNativeSessionId: 'native-1',
      recentMessages: ['用户：登录失败', 'Codex：定位到 auth.ts'],
      terminalHistory: '',
      transcriptPath: 'codex:native-1',
      gitSummary: 'M src/auth.ts'
    })

    expect(md).toContain('你正在从 codex 接手')
    expect(md).toContain('第一条回复必须包含')
    expect(md).toContain('M src/auth.ts')
  })
})
