import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildClaudeHeadlessTurn,
  parseClaudeStreamEvent
} from '../src/main/domains/adapters/claude/control'

const fixture = resolve('tests/fixtures/control/claude/2.1.170/turn.synthetic.jsonl')

describe('Claude headless control channel', () => {
  it('builds the verified verbose stream-json command with resume and hook settings', () => {
    const launch = buildClaudeHeadlessTurn({
      prompt: '检查代码',
      nativeSessionId: '00000000-0000-4000-8000-000000000016',
      model: 'claude-sonnet-4-5',
      approvalUrl: 'http://127.0.0.1:4567/permission',
      approvalToken: 'secret',
      turnId: 'turn-1'
    })

    expect(launch.command).toBe('claude')
    expect(launch.args).toEqual([
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--resume',
      '00000000-0000-4000-8000-000000000016',
      '--model',
      'claude-sonnet-4-5',
      '--settings',
      expect.stringContaining('"PreToolUse"'),
      '检查代码'
    ])
    expect(launch.env).toEqual({
      AGENT_OS_APPROVAL_TOKEN: 'secret',
      AGENT_OS_CHAT_TURN_ID: 'turn-1'
    })
  })

  it('maps the recorded stream-json subset without dropping unknown events', () => {
    const events = readFileSync(fixture, 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => parseClaudeStreamEvent(line))

    expect(events).toEqual([
      {
        kind: 'session-bound',
        nativeSessionId: '00000000-0000-4000-8000-000000000016',
        model: 'claude-sonnet-4-5'
      },
      { kind: 'text-delta', text: '正在检查' },
      {
        kind: 'tool-start',
        toolUseId: 'toolu_01',
        toolName: 'Read',
        input: { file_path: 'src/App.tsx' }
      },
      {
        kind: 'tool-result',
        toolUseId: 'toolu_01',
        content: 'export function App() {}',
        isError: false
      },
      { kind: 'turn-end', status: 'completed', costUsd: 0.0012 },
      {
        kind: 'error',
        message: '连接异常（unknown），正在进行第 1/10 次重试',
        retryable: true
      },
      {
        kind: 'unknown',
        rawType: 'future_event',
        payload: { type: 'future_event', payload: { value: 1 } }
      }
    ])
  })

  it('turns malformed lines into an observable unknown event', () => {
    expect(parseClaudeStreamEvent('{bad json')).toEqual([
      {
        kind: 'unknown',
        rawType: 'invalid-json',
        payload: '{bad json'
      }
    ])
  })
})
