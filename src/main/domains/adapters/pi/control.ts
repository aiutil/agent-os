// Pi 结构化聊天控制面（chat surface 支持）。
// 协议：`pi --mode json --print <message> [--session-id <id>] [--model <model>]`
// stdout 逐行 JSON；session-id 复用原生回话；--continue 不适合 print 模式，用 --session-id 代替。

import type { AgentEvent } from '../../../../shared/types/agent-event'
import type { HeadlessTurnInput, HeadlessTurnLaunch, HeadlessTurnParser } from '../types'
import { composeStdinPrompt, invalidJsonEvent, isRecord } from '../headless-utils'

export function buildPiHeadlessTurn(input: HeadlessTurnInput): HeadlessTurnLaunch {
  const args: string[] = ['--mode', 'json', '--print']
  if (input.isolated) {
    // Memory curator 只需要模型对已脱敏文本做 JSON 提炼；禁止工具、扩展、项目规则和
    // session 落盘，避免它读取/改写工作区或把原文留在 Pi 私有历史里。
    args.push('--no-tools', '--no-session', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates')
  }
  if (input.model) args.push('--model', input.model)
  if (input.reasoningEffort) args.push('--thinking', input.reasoningEffort)
  if (input.nativeSessionId) args.push('--session-id', input.nativeSessionId)
  for (const file of input.files ?? []) args.push(`@${file}`)
  const prompt = composeStdinPrompt(input)
  if (prompt) args.push(prompt)
  return { command: 'pi', args, env: {} }
}

export function createPiParser(): HeadlessTurnParser {
  let boundSession = false
  const seenTools = new Set<string>()

  return {
    parse(line: string): AgentEvent[] {
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        return invalidJsonEvent(line)
      }
      if (!isRecord(obj)) return []

      const events: AgentEvent[] = []

      // session → bind native session id
      if (obj.type === 'session' && typeof obj.id === 'string' && !boundSession) {
        boundSession = true
        events.push({ kind: 'session-bound', nativeSessionId: obj.id })
        return events
      }

      // turn_end → signal completion
      if (obj.type === 'turn_end') {
        events.push({ kind: 'turn-end', status: 'completed' })
        return events
      }

      // message_update carries all streaming content
      if (obj.type === 'message_update' && isRecord(obj.assistantMessageEvent)) {
        const ev = obj.assistantMessageEvent
        const evType = typeof ev.type === 'string' ? ev.type : ''

        if (evType === 'text_delta' && typeof ev.delta === 'string' && ev.delta) {
          events.push({ kind: 'text-delta', text: ev.delta })
          return events
        }

        if (evType === 'thinking_delta' && typeof ev.delta === 'string' && ev.delta) {
          events.push({ kind: 'thinking-delta', text: ev.delta })
          return events
        }

        if (evType === 'tool_use_start' && isRecord(ev.partial)) {
          const content = Array.isArray(ev.partial.content) ? ev.partial.content : []
          const toolEntry = content.find(
            (c) => isRecord(c) && c.type === 'tool_use'
          )
          if (isRecord(toolEntry) && typeof toolEntry.id === 'string') {
            const toolId = toolEntry.id
            if (!seenTools.has(toolId)) {
              seenTools.add(toolId)
              events.push({
                kind: 'tool-start',
                toolUseId: toolId,
                toolName: typeof toolEntry.name === 'string' ? toolEntry.name : 'unknown',
                input: isRecord(toolEntry.input) ? toolEntry.input : null
              })
            }
          }
          return events
        }

        if (evType === 'tool_result') {
          const toolUseId = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : null
          if (toolUseId) {
            events.push({
              kind: 'tool-result',
              toolUseId,
              content: typeof ev.content === 'string' ? ev.content : '',
              isError: ev.is_error === true
            })
          }
          return events
        }
      }

      return events
    }
  }
}
