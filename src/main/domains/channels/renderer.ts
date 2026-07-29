// SPEC-034 消息渠道 —— 出站渲染（纯函数）。
// 把 agent 的结构化结果（累积的助手文本）+ 深链组装成 OneBot v12 段；
// 以及入站斜杠命令解析。状态由 ChannelManager 持有，这里保持无副作用、可单测。

import type { OneBotSegment } from '@shared/types'
import { tr } from '@shared/i18n'

/** 组装最终回复段：仅助手文本（深链按用户要求隐藏，桌面端仍可用 /open 命令取回）。 */
export function buildReplySegments(assistantText: string, _deepLink?: string): OneBotSegment[] {
  const text = assistantText.trim()
  return text ? [{ type: 'text', data: { text } }] : []
}

/** 即时确认段（收到消息→agent 接手前）。 */
export function ackSegments(agentLabel: string): OneBotSegment[] {
  return [
    { type: 'text', data: { text: tr('channels.message.takingOver', { label: agentLabel }) } }
  ]
}

/** 一段正文增量（分段流式：每攒够一段就单独发一条）。空文本返回 []。 */
export function chunkSegments(text: string): OneBotSegment[] {
  const t = text.trim()
  return t ? [{ type: 'text', data: { text: t } }] : []
}

/** 工具调用的简短进度行（分段流式：tool-start 时单独发一条，让用户看到 agent 在动）。 */
export function toolProgressLine(toolName: string, input: unknown): string {
  const arg = pickToolArg(input)
  const tail = arg ? ` · ${truncate(arg, 60)}` : ''
  return `🔧 ${toolName}${tail}`
}

/** 从工具入参里挑一个有信息量的字段做展示（路径/命令/模式等）。 */
function pickToolArg(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'notebook_path']) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 解析入站斜杠命令；未知命令也显式返回，避免误交给 agent 当普通任务执行。 */
export function parseCommand(text: string): {
  cmd:
    | 'stop'
    | 'open'
    | 'agents'
    | 'use'
    | 'new'
    | 'cd'
    | 'status'
    | 'help'
    | 'sessions'
    | 'session'
    | 'tasks'
    | 'task'
    | 'steer'
    | 'unknown'
  arg: string
} | null {
  const m = text.trim().match(/^\/([^\s/]+)(?:\s+(.*))?$/u)
  if (!m) return null
  const cmd = m[1].split('@', 1)[0].toLowerCase()
  const known = [
    'stop',
    'open',
    'agents',
    'use',
    'new',
    'cd',
    'status',
    'help',
    'sessions',
    'session',
    'tasks',
    'task',
    'steer'
  ] as const
  if (!known.includes(cmd as (typeof known)[number])) return { cmd: 'unknown', arg: cmd }
  return { cmd: cmd as (typeof known)[number], arg: (m[2] ?? '').trim() }
}
