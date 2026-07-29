// OpenCode 结构化聊天控制面（SPEC-019）。
// 参考 OpenDesign（nexu-io/open-design, Apache-2.0）runtimes/defs/opencode.ts 与
// json-event-stream.ts handleOpenCodeEvent，在本仓 AgentEvent 体系内重新实现。
//
// 通道形态：`opencode run --format json <message>` 单次 spawn，
// stdout 逐行 JSON；有原生 session 时通过 --session 继续。

import type { AgentEvent } from '../../../../shared/types/agent-event'
import type { HeadlessTurnInput, HeadlessTurnLaunch, HeadlessTurnParser } from '../types'
import { composeStdinPrompt, invalidJsonEvent, isRecord, stringifyContent } from '../headless-utils'

export function buildOpenCodeHeadlessTurn(input: HeadlessTurnInput): HeadlessTurnLaunch {
  const args = ['run', '--format', 'json']
  if (input.model && input.model !== 'default') {
    args.push('-m', input.model)
  }
  if (input.reasoningEffort) args.push('--variant', input.reasoningEffort)
  if (input.nativeSessionId) {
    args.push('--session', input.nativeSessionId)
  }
  // 附件（opencode run -f/--file 接受本地磁盘路径，实测 opencode 1.17.11）。
  // 注意：与 claude --file 不同名同义——claude --file 是远端 file_id 下载，
  // opencode -f 才是真的本地文件附件。
  if (input.files?.length) {
    for (const f of input.files) args.push('--file', f)
  }
  const prompt = composeStdinPrompt(input)
  if (prompt) args.push(prompt)
  return {
    command: 'opencode',
    args,
    env: {}
  }
}

export function createOpenCodeParser(): HeadlessTurnParser {
  const seenTools = new Set<string>()
  let boundSession = false

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

      const events: AgentEvent[] = []
      const sessionId = typeof obj.sessionID === 'string' ? obj.sessionID : null
      if (sessionId && !boundSession) {
        boundSession = true
        events.push({ kind: 'session-bound', nativeSessionId: sessionId })
      }

      const part = isRecord(obj.part) ? obj.part : {}

      if (obj.type === 'step_start' || obj.type === 'step_finish') {
        return events
      }

      if (obj.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        events.push({ kind: 'text-delta', text: part.text })
        return events
      }

      if (obj.type === 'tool_use' && typeof part.tool === 'string' && typeof part.callID === 'string') {
        const statePart = isRecord(part.state) ? part.state : null
        const key = `${sessionId ?? 'session'}:${part.callID}`
        if (!seenTools.has(key)) {
          seenTools.add(key)
          events.push({
            kind: 'tool-start',
            toolUseId: part.callID,
            toolName: part.tool,
            input: parseMaybeJson(statePart?.input) ?? statePart?.input ?? null
          })
        }
        if (statePart?.status === 'completed') {
          events.push({
            kind: 'tool-result',
            toolUseId: part.callID,
            content: stringifyContent(statePart.output),
            isError: false
          })
        }
        return events
      }

      if (obj.type === 'error') {
        events.push({
          kind: 'error',
          message: extractOpenCodeError(obj.error ?? obj.message, 'OpenCode 错误')
        })
        return events
      }

      events.push({
        kind: 'unknown',
        rawType: typeof obj.type === 'string' ? obj.type : 'unknown',
        payload: obj
      })
      return events
    }
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function extractOpenCodeError(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value) return value
  if (isRecord(value)) {
    if (typeof value.message === 'string' && value.message) return value.message
    if (typeof value.detail === 'string' && value.detail) return value.detail
  }
  return fallback
}
