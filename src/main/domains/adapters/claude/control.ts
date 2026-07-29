import type { AgentEvent } from '../../../../shared/types/agent-event'
import type { HeadlessTurnInput, HeadlessTurnLaunch, HeadlessTurnParser } from '../types'

interface JsonRecord {
  type?: string
  subtype?: string
  session_id?: string
  model?: string
  total_cost_usd?: number
  stop_reason?: string
  attempt?: number
  max_retries?: number
  /** api_retry 帧携带的失败原因（HTTP 状态码 / 错误描述），用于拼出可读重试提示。 */
  error_status?: string | number
  error?: string
  event?: {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string }
  }
  message?: {
    content?: Array<{
      type?: string
      id?: string
      name?: string
      text?: string
      input?: unknown
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }>
  }
}

function hookSettings(input: HeadlessTurnInput): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'http',
              url: input.approvalUrl,
              headers: {
                Authorization: 'Bearer $AGENT_OS_APPROVAL_TOKEN',
                'X-Agent-OS-Turn': '$AGENT_OS_CHAT_TURN_ID'
              },
              allowedEnvVars: ['AGENT_OS_APPROVAL_TOKEN', 'AGENT_OS_CHAT_TURN_ID'],
              timeout: 600,
              statusMessage: '等待 Agent OS 审批'
            }
          ]
        }
      ]
    }
  })
}

/**
 * 把附件绝对路径拼进 prompt 末尾，让 Claude 用 Read 工具按需读取。
 *
 * 为什么不用 `claude --file`：`--file <specs...>` 的语义是「下载远端 file resource」
 * （`file_id:relative_path`，需 CLAUDE_CODE_SESSION_ACCESS_TOKEN），传本地路径会抛
 * "Session token required for file downloads"。claude headless 也没有 `--image` 或
 * `@path` 展开。本地附件的正路只有两条：① prompt 里给路径让 Read 工具读（本实现，
 * 与 gemini @ref 同思路，Read 能渲染图片/PDF/文本）；② --input-format stream-json
 * 走 base64 内联（更原生但需重写输入通道，留作后续）。选 ① 是为了外科手术式修复、
 * 与既有 argv-prompt 路径零回归。
 */
function appendAttachmentRefs(prompt: string | undefined, files?: string[]): string {
  if (!files?.length) return prompt ?? ''
  const list = files.map((file) => `- ${file}`).join('\n')
  const block = `# 附件\n用户上传了以下文件，请用 Read 工具按需读取后再回答：\n${list}`
  return prompt ? `${prompt}\n\n${block}` : block
}

export function buildClaudeHeadlessTurn(input: HeadlessTurnInput): HeadlessTurnLaunch {
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages']
  if (input.nativeSessionId) args.push('--resume', input.nativeSessionId)
  if (input.model) args.push('--model', input.model)
  if (input.reasoningEffort) args.push('--effort', input.reasoningEffort)
  args.push('--settings', hookSettings(input))
  const prompt = appendAttachmentRefs(input.prompt, input.files)
  if (prompt) args.push(prompt)
  return {
    command: 'claude',
    args,
    env: {
      AGENT_OS_APPROVAL_TOKEN: input.approvalToken,
      AGENT_OS_CHAT_TURN_ID: input.turnId
    }
  }
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        typeof item === 'string'
          ? item
          : typeof item === 'object' && item && 'text' in item
            ? String((item as { text?: unknown }).text ?? '')
            : JSON.stringify(item)
      )
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

export function parseClaudeStreamEvent(line: string): AgentEvent[] {
  let record: JsonRecord
  try {
    record = JSON.parse(line) as JsonRecord
  } catch {
    return [{ kind: 'unknown', rawType: 'invalid-json', payload: line }]
  }

  if (record.type === 'system' && record.subtype === 'init' && record.session_id) {
    return [
      {
        kind: 'session-bound',
        nativeSessionId: record.session_id,
        ...(record.model ? { model: record.model } : {})
      }
    ]
  }
  if (
    record.type === 'stream_event' &&
    record.event?.type === 'content_block_delta' &&
    record.event.delta?.type === 'thinking_delta' &&
    record.event.delta.thinking
  ) {
    return [{ kind: 'thinking-delta', text: record.event.delta.thinking }]
  }
  if (
    record.type === 'stream_event' &&
    record.event?.type === 'content_block_delta' &&
    record.event.delta?.type === 'text_delta' &&
    record.event.delta.text
  ) {
    return [{ kind: 'text-delta', text: record.event.delta.text }]
  }
  if (record.type === 'assistant') {
    return (record.message?.content ?? []).flatMap((content) =>
      content.type === 'tool_use' && content.id && content.name
        ? [
            {
              kind: 'tool-start' as const,
              toolUseId: content.id,
              toolName: content.name,
              input: content.input
            }
          ]
        : []
    )
  }
  if (record.type === 'user') {
    return (record.message?.content ?? []).flatMap((content) =>
      content.type === 'tool_result' && content.tool_use_id
        ? [
            {
              kind: 'tool-result' as const,
              toolUseId: content.tool_use_id,
              content: stringifyContent(content.content),
              isError: Boolean(content.is_error)
            }
          ]
        : []
    )
  }
  if (record.type === 'result') {
    if (record.stop_reason === 'tool_deferred') return []
    return [
      {
        kind: 'turn-end',
        status: record.subtype === 'error_during_execution' ? 'interrupted' : 'completed',
        ...(typeof record.total_cost_usd === 'number' ? { costUsd: record.total_cost_usd } : {})
      }
    ]
  }
  if (record.type === 'system' && record.subtype === 'api_retry') {
    const reason = [record.error_status, record.error].filter((part) => part != null && part !== '').join(' ')
    return [
      {
        kind: 'error',
        message: `连接异常${reason ? `（${reason}）` : ''}，正在进行第 ${record.attempt ?? '?'}${
          record.max_retries ? `/${record.max_retries}` : ''
        } 次重试`,
        retryable: true
      }
    ]
  }
  return [
    {
      kind: 'unknown',
      rawType: record.type ?? 'unknown',
      payload: record
    }
  ]
}

function parseAssistantText(line: string): string {
  let record: JsonRecord
  try {
    record = JSON.parse(line) as JsonRecord
  } catch {
    return ''
  }
  if (record.type !== 'assistant') return ''
  return (record.message?.content ?? [])
    .filter((content) => content.type === 'text' && typeof content.text === 'string')
    .map((content) => content.text)
    .join('')
}

/**
 * 包装为 SPEC-019 的 `HeadlessTurnParser`。Claude 新版本或第三方兼容网关
 * 可能只输出 assistant 消息快照，这里补成增量文本，避免会话区空白。
 */
export function createClaudeParser(): HeadlessTurnParser {
  let sawStreamingText = false
  let lastAssistantText = ''
  return {
    parse(line: string): AgentEvent[] {
      const events = parseClaudeStreamEvent(line)
      if (events.some((event) => event.kind === 'text-delta')) {
        sawStreamingText = true
        return events
      }
      const assistantText = sawStreamingText ? '' : parseAssistantText(line)
      if (!assistantText) return events
      const delta = assistantText.startsWith(lastAssistantText)
        ? assistantText.slice(lastAssistantText.length)
        : assistantText
      lastAssistantText = assistantText
      return delta ? [...events, { kind: 'text-delta', text: delta }] : events
    }
  }
}
