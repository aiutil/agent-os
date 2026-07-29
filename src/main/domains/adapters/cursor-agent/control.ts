// Cursor Agent 结构化聊天控制面（SPEC-019）。
// 参考 OpenDesign（nexu-io/open-design, Apache-2.0）runtimes/defs/cursor-agent.ts 与
// json-event-stream.ts handleCursorEvent，在本仓 AgentEvent 体系内重新实现。
//
// 通道形态：`cursor-agent --print --output-format stream-json --force --trust` 单次
// spawn，prompt 经 stdin 投递。cursor 用 `--stream-partial-output` 发增量 assistant
// 消息，回合末尾会 replay 全量文本——需对账避免重复（见下）。无 headless resume。

import type { AgentEvent } from '../../../../shared/types/agent-event'
import type { HeadlessTurnInput, HeadlessTurnLaunch, HeadlessTurnParser } from '../types'
import { composeStdinPrompt, invalidJsonEvent, isRecord } from '../headless-utils'

export function buildCursorAgentHeadlessTurn(input: HeadlessTurnInput): HeadlessTurnLaunch {
  const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--force', '--trust']
  if (input.model && input.model !== 'default') {
    args.push('--model', input.model)
  }
  return {
    command: 'cursor-agent',
    args,
    env: {},
    stdin: composeStdinPrompt(input)
  }
}

function extractCursorText(message: unknown): string {
  const content = isRecord(message) ? message.content : undefined
  const blocks = Array.isArray(content) ? content : []
  return blocks
    .filter(
      (b): b is { type: 'text'; text: string } =>
        isRecord(b) && b.type === 'text' && typeof b.text === 'string'
    )
    .map((b) => b.text)
    .join('')
}

export function createCursorAgentParser(): HeadlessTurnParser {
  let textSoFar = ''
  let turnStart = 0
  let boundSession = false

  // replay 全量文本时只补发尚未发出的后缀（对齐 reconcileCursorTurnReplay）。
  function reconcile(text: string): AgentEvent[] {
    const emittedTurn = textSoFar.slice(turnStart)
    const events: AgentEvent[] = []
    if (text && text !== emittedTurn && text.startsWith(emittedTurn)) {
      const suffix = text.slice(emittedTurn.length)
      if (suffix) {
        events.push({ kind: 'text-delta', text: suffix })
        textSoFar += suffix
      }
    }
    turnStart = textSoFar.length
    return events
  }

  return {
    parse(line: string): AgentEvent[] {
      const obj = ((): unknown => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })()
      if (obj === undefined) return invalidJsonEvent(line)
      if (!isRecord(obj)) return []

      if (obj.type === 'system' && obj.subtype === 'init') {
        const sid = typeof obj.session_id === 'string' ? obj.session_id : null
        if (sid && !boundSession) {
          boundSession = true
          return [
            {
              kind: 'session-bound',
              nativeSessionId: sid,
              ...(typeof obj.model === 'string' ? { model: obj.model } : {})
            }
          ]
        }
        return []
      }

      if (obj.type === 'assistant' && obj.message) {
        const text = extractCursorText(obj.message)
        // 带时间戳且无 model_call_id 的是实时增量 delta，逐条原样发出。
        if (typeof obj.model_call_id !== 'string' && typeof obj.timestamp_ms === 'number') {
          if (!text) return []
          textSoFar += text
          return [{ kind: 'text-delta', text }]
        }
        // model_call_id 或无时间戳的终态消息是全量 replay，对账补后缀。
        return reconcile(text)
      }

      if (obj.type === 'result') {
        return [{ kind: 'turn-end', status: 'completed' }]
      }

      return [
        { kind: 'unknown', rawType: typeof obj.type === 'string' ? obj.type : 'unknown', payload: obj }
      ]
    }
  }
}
