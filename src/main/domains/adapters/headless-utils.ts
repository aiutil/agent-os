// 对话镜头多 CLI 适配的共享工具（SPEC-019）。
// 设计参考 OpenDesign（nexu-io/open-design, Apache-2.0）的 json-event-stream.ts
// 与 RuntimeContext transcript 注入思路，在本仓 AgentEvent 类型体系内重新实现。

import type { AgentEvent, ChatTurnMessage } from '../../../shared/types/agent-event'
import type { HeadlessTurnInput } from './types'

/** 单行 JSON 解析失败时的统一未识别事件。 */
export function invalidJsonEvent(line: string): AgentEvent[] {
  return [{ kind: 'unknown', rawType: 'invalid-json', payload: line }]
}

/** 安全 JSON 解析；失败返回 null（不抛）。 */
export function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** 把任意工具结果内容文本化为可展示字符串。 */
export function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        typeof item === 'string'
          ? item
          : isRecord(item) && typeof item.text === 'string'
            ? item.text
            : JSON.stringify(item)
      )
      .join('\n')
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/**
 * 为无原生会话记忆的适配器组合 stdin prompt：把历史回合渲染成
 * `## user` / `## assistant` 块（与 OpenDesign 的 daemon transcript 标记一致），
 * 末尾追加本回合最新用户消息。无历史时直接返回 prompt。
 */
export function composeStdinPrompt(input: HeadlessTurnInput): string {
  const latest = (input.prompt ?? '').trim()
  const history = input.transcript ?? []
  if (history.length === 0) return latest
  const blocks = history
    .map((m: ChatTurnMessage) => `## ${m.role}\n\n${m.text.trim()}`)
    .join('\n\n')
  return latest ? `${blocks}\n\n## user\n\n${latest}` : blocks
}

/**
 * 从单行文本中抽取 CLI 打印的原生会话 id（兼容 "session id:" / "session_id:" /
 * "native session:" 等）。纯文本解析器（stdout）与 manager 的 stderr 兜底绑定共用，
 * 覆盖 hermes --quiet 把 session_id 打到 stderr 的情形。
 */
export function extractSessionId(line: string): string | null {
  const match = line.match(/^(?:session(?:[_\s-]?id)?|native[_\s-]?session)\s*[:=]\s*(\S+)/i)
  return match?.[1] ?? null
}
