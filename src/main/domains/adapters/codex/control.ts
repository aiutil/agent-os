// Codex 结构化聊天控制面（SPEC-019）。
// 启动参数与事件映射参考 OpenDesign（nexu-io/open-design, Apache-2.0）的
// runtimes/defs/codex.ts 与 json-event-stream.ts handleCodexEvent，在本仓
// AgentEvent 类型体系内重新实现。
//
// 通道形态：`codex exec --json` 单次 spawn，prompt 经 stdin 投递，stdout 逐行
// JSON 事件。codex 无可用的 headless 多回合 resume，故 supportsNativeResume=false，
// 由宿主把历史 transcript 重组进 prompt（见 composeStdinPrompt）。

import type { AgentEvent } from '../../../../shared/types/agent-event'
import type { HeadlessTurnInput, HeadlessTurnLaunch, HeadlessTurnParser } from '../types'
import { assertAttachmentsSupported } from '../attachments'
import { composeStdinPrompt, invalidJsonEvent, isRecord, stringifyContent } from '../headless-utils'

export function buildCodexHeadlessTurn(input: HeadlessTurnInput): HeadlessTurnLaunch {
  // 全自动预设 → danger-full-access；其余 → workspace-write（含网络）。
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox']
  if (input.permissionPreset === 'auto') {
    args.push('danger-full-access')
  } else {
    args.push('workspace-write', '-c', 'sandbox_workspace_write.network_access=true')
  }
  if (input.model && input.model !== 'default') {
    args.push('--model', input.model)
  }
  if (input.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${input.reasoningEffort}"`)
  }
  const attachmentCapabilities = {
    images: true,
    files: false,
    allowedExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp']
  }
  assertAttachmentsSupported('Codex', attachmentCapabilities, input.files)
  for (const file of input.files ?? []) args.push('--image', file)
  return {
    command: 'codex',
    args,
    env: {},
    stdin: composeStdinPrompt(input)
  }
}

export function createCodexParser(): HeadlessTurnParser {
  const seenTools = new Set<string>()
  let errorEmitted = false
  let prevWasAgentMessage = false
  let lastEndedWithNewline = false

  function emitError(message: string): AgentEvent[] {
    if (errorEmitted) return []
    errorEmitted = true
    return [{ kind: 'error', message }]
  }

  function commandToolEvents(item: Record<string, unknown>): AgentEvent[] {
    const id = typeof item.id === 'string' ? item.id : null
    if (!id) return []
    const events: AgentEvent[] = []
    if (!seenTools.has(id)) {
      seenTools.add(id)
      events.push({
        kind: 'tool-start',
        toolUseId: id,
        toolName: 'Bash',
        input: { command: typeof item.command === 'string' ? item.command : '' }
      })
    }
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

      const type = obj.type

      if (type === 'error') {
        return emitError(extractCodexError(obj.message ?? obj.error, 'Codex 错误'))
      }
      if (type === 'turn.failed') {
        return emitError(extractCodexError(obj.error ?? obj.message, 'Codex 回合失败'))
      }

      if (type === 'thread.started') {
        const threadId = typeof obj.thread_id === 'string' ? obj.thread_id : null
        return threadId ? [{ kind: 'session-bound', nativeSessionId: threadId }] : []
      }

      if (type === 'turn.started') {
        prevWasAgentMessage = false
        lastEndedWithNewline = false
        return []
      }

      if ((type === 'item.started' || type === 'item.completed') && isRecord(obj.item)) {
        const item = obj.item
        if (item.type === 'command_execution') {
          prevWasAgentMessage = false
          lastEndedWithNewline = false
          const events = commandToolEvents(item)
          if (type === 'item.completed' && typeof item.id === 'string') {
            const content = stringifyContent(item.aggregated_output ?? '')
            events.push({
              kind: 'tool-result',
              toolUseId: item.id,
              content,
              isError:
                typeof item.exit_code === 'number'
                  ? item.exit_code !== 0
                  : item.status === 'failed'
            })
          }
          return events
        }
        if (
          type === 'item.completed' &&
          item.type === 'agent_message' &&
          typeof item.text === 'string' &&
          item.text.length > 0
        ) {
          // 多条 agent_message 之间补换行边界（对齐 OpenDesign）。
          const text = item.text
          const needsBoundary =
            prevWasAgentMessage && !lastEndedWithNewline && !text.startsWith('\n')
          const delta = needsBoundary ? `\n${text}` : text
          prevWasAgentMessage = true
          lastEndedWithNewline = text.endsWith('\n')
          return [{ kind: 'text-delta', text: delta }]
        }
        // 其余 item 子类型（推理、todo 等）本版不渲染。
        return []
      }

      if (type === 'turn.completed') {
        return [{ kind: 'turn-end', status: 'completed' }]
      }

      return [{ kind: 'unknown', rawType: typeof type === 'string' ? type : 'unknown', payload: obj }]
    }
  }
}

function extractCodexError(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value) return value
  if (isRecord(value)) {
    if (typeof value.message === 'string' && value.message) return value.message
    if (typeof value.detail === 'string' && value.detail) return value.detail
  }
  return fallback
}
