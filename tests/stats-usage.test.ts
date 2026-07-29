import { describe, expect, it } from 'vitest'
import {
  createClaudeUsageCollector,
  createCodexUsageCollector
} from '../src/main/domains/stats/usage'

describe('usage facts', () => {
  it('Claude 同一 assistant message 只保留最终 usage 快照', () => {
    const collector = createClaudeUsageCollector()
    collector.visit({
      type: 'assistant',
      timestamp: '2026-06-12T01:00:00.000Z',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 2 }
      }
    })
    collector.visit({
      type: 'assistant',
      timestamp: '2026-06-12T01:00:01.000Z',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 30
        }
      }
    })

    expect(collector.finish()).toEqual([
      {
        key: 'claude:msg-1',
        model: 'claude-sonnet-4-6',
        timestamp: '2026-06-12T01:00:01.000Z',
        tokens: { input: 20, output: 8, cacheWrite: 5, cacheRead: 30 }
      }
    ])
  })

  it('Codex 同一 turn 的 token_count 只保留末次 last_token_usage', () => {
    const collector = createCodexUsageCollector()
    collector.visit({
      type: 'turn_context',
      timestamp: '2026-06-12T02:00:00.000Z',
      payload: { turn_id: 'turn-1', model: 'gpt-5.3-codex' }
    })
    collector.visit({
      type: 'event_msg',
      timestamp: '2026-06-12T02:00:01.000Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20
          }
        }
      }
    })
    collector.visit({
      type: 'event_msg',
      timestamp: '2026-06-12T02:00:02.000Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 140,
            cached_input_tokens: 60,
            output_tokens: 30
          }
        }
      }
    })

    expect(collector.finish()).toEqual([
      {
        key: 'codex:turn-1',
        model: 'gpt-5.3-codex',
        timestamp: '2026-06-12T02:00:02.000Z',
        tokens: { input: 80, output: 30, cacheWrite: 0, cacheRead: 60 }
      }
    ])
  })

  it('Codex 缺少 last_token_usage 时使用相邻累计值差额', () => {
    const collector = createCodexUsageCollector()
    collector.visit({
      type: 'event_msg',
      timestamp: '2026-06-12T02:00:00.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10
          }
        }
      }
    })
    collector.visit({
      type: 'turn_context',
      payload: { turn_id: 'turn-2', model: 'gpt-5.3-codex' }
    })
    collector.visit({
      type: 'event_msg',
      timestamp: '2026-06-12T02:01:00.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 250,
            cached_input_tokens: 50,
            output_tokens: 40
          }
        }
      }
    })

    expect(collector.finish().at(-1)).toEqual({
      key: 'codex:turn-2',
      model: 'gpt-5.3-codex',
      timestamp: '2026-06-12T02:01:00.000Z',
      tokens: { input: 120, output: 30, cacheWrite: 0, cacheRead: 30 }
    })
  })
})
