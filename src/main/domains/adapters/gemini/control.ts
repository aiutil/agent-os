// Gemini CLI headless control channel.
// Contract verified against @google/gemini-cli 0.46.0 docs bundled in the npm
// package: `-p/--prompt`, `--output-format stream-json`, `--resume`, and
// `--approval-mode`.

import type { AgentEvent } from '../../../../shared/types/agent-event'
import type { HeadlessTurnInput, HeadlessTurnLaunch, HeadlessTurnParser } from '../types'
import { composeStdinPrompt, invalidJsonEvent, isRecord, stringifyContent } from '../headless-utils'

export function buildGeminiHeadlessTurn(input: HeadlessTurnInput): HeadlessTurnLaunch {
  let prompt = composeStdinPrompt(input)
  // 附件：gemini 用 @<abspath> 引用语法（绝对路径，与 cwd 无关）。依据见 SPEC-038。
  if (input.files?.length) {
    const refs = input.files.map((f) => `@${f}`).join(' ')
    prompt = prompt ? `${prompt}\n\n${refs}` : refs
  }
  const args = ['--output-format', 'stream-json', '--prompt', prompt, '--skip-trust']

  if (input.model && input.model !== 'default') {
    args.push('--model', input.model)
  }
  if (input.nativeSessionId) {
    args.push('--resume', input.nativeSessionId)
  }
  args.push('--approval-mode', approvalMode(input.permissionPreset))

  return {
    command: 'gemini',
    args,
    env: {}
  }
}

export function createGeminiParser(): HeadlessTurnParser {
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

      const type = obj.type
      if (type === 'init') {
        const events: AgentEvent[] = []
        const sessionId = typeof obj.session_id === 'string' ? obj.session_id : null
        if (sessionId && !boundSession) {
          boundSession = true
          const model = typeof obj.model === 'string' ? obj.model : undefined
          events.push({ kind: 'session-bound', nativeSessionId: sessionId, ...(model ? { model } : {}) })
        }
        return events
      }

      if (type === 'message' && obj.role === 'assistant') {
        const content = typeof obj.content === 'string' ? obj.content : stringifyContent(obj.content)
        return content ? [{ kind: 'text-delta', text: content }] : []
      }

      if (type === 'tool_use') {
        const toolUseId = typeof obj.tool_id === 'string' ? obj.tool_id : null
        const toolName = typeof obj.tool_name === 'string' ? obj.tool_name : 'tool'
        if (!toolUseId) return []
        return [{ kind: 'tool-start', toolUseId, toolName, input: obj.parameters ?? null }]
      }

      if (type === 'tool_result') {
        const toolUseId = typeof obj.tool_id === 'string' ? obj.tool_id : null
        if (!toolUseId) return []
        const status = typeof obj.status === 'string' ? obj.status : 'success'
        const error = isRecord(obj.error) ? obj.error : null
        return [
          {
            kind: 'tool-result',
            toolUseId,
            content: stringifyContent(error?.message ?? obj.output ?? ''),
            isError: status === 'error' || error != null
          }
        ]
      }

      if (type === 'error') {
        return [{ kind: 'error', message: geminiErrorMessage(obj, 'Gemini CLI 错误') }]
      }

      if (type === 'result') {
        if (obj.status === 'error') {
          return [{ kind: 'error', message: geminiErrorMessage(obj.error, 'Gemini CLI 回合失败') }]
        }
        return [{ kind: 'turn-end', status: 'completed' }]
      }

      return [{ kind: 'unknown', rawType: typeof type === 'string' ? type : 'unknown', payload: obj }]
    }
  }
}

function approvalMode(preset: HeadlessTurnInput['permissionPreset']): string {
  if (preset === 'auto') return 'yolo'
  if (preset === 'acceptEdits') return 'auto_edit'
  return 'default'
}

function geminiErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value) return value
  if (isRecord(value)) {
    if (typeof value.message === 'string' && value.message) return value.message
    if (typeof value.type === 'string' && value.type) return value.type
  }
  return fallback
}
