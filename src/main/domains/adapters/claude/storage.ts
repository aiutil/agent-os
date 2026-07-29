import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AdapterSessionStorage,
  NormalizedTranscript
} from '../../../../shared/types/transcript'
import {
  asRecord,
  asString,
  compactJson,
  createTranscriptStream,
  fallbackTitle,
  listTranscriptFiles,
  visitJsonRecords,
  type DraftMessage
} from '../storage-utils'
import { createClaudeUsageCollector } from '../../stats/usage'
import { deriveTranscriptTitle, isHumanTranscriptText } from '@shared/transcript/title'

const ROOT = join(homedir(), '.claude', 'projects')
const SKIPPED_RECORD_TYPES = new Set([
  'attachment',
  'file-history-snapshot',
  'last-prompt',
  'permission-mode',
  'progress',
  'queue-operation',
  'summary'
])

export const claudeSessionStorage: AdapterSessionStorage = {
  support: 'full',
  rootDirs: () => [ROOT],
  locateDir(cwd) {
    const dir = join(ROOT, cwd.replace(/[^0-9A-Za-z]/g, '-'))
    return existsSync(dir) ? dir : null
  },
  listSessionFiles(dir) {
    return listTranscriptFiles(dir, 'claude')
  },
  parseTranscript(path, options) {
    return createTranscriptStream(path, parseClaudeRecord, options, createClaudeUsageCollector())
  },
  async readMeta(path) {
    let nativeSessionId: string | undefined
    let cwd: string | null = null
    let summary: string | undefined
    let firstUserMessage: string | undefined
    let startedAt: string | null = null

    await visitJsonRecords(path, (record) => {
      nativeSessionId ??= asString(record.sessionId)
      cwd ??= asString(record.cwd) ?? null
      startedAt ??= asString(record.timestamp) ?? null
      if (record.type === 'summary') summary ??= asString(record.summary)
      if (!firstUserMessage && record.type === 'user') {
        const candidate = firstHumanUserText(asRecord(record.message)?.content)
        if (candidate && isHumanTranscriptText(candidate)) firstUserMessage = candidate
      }
    })

    return {
      nativeSessionId: nativeSessionId ?? fallbackTitle(path),
      cwd,
      title: deriveTranscriptTitle({
        preferred: summary,
        firstHumanText: firstUserMessage,
        fallback: fallbackTitle(path)
      }),
      startedAt
    } satisfies Pick<NormalizedTranscript, 'nativeSessionId' | 'cwd' | 'title' | 'startedAt'>
  }
}

function parseClaudeRecord(record: Record<string, unknown>): DraftMessage[] {
  const kind = asString(record.type) ?? 'unknown'
  if (SKIPPED_RECORD_TYPES.has(kind)) return []

  const timestamp = asString(record.timestamp)
  if (kind === 'user' || kind === 'assistant' || kind === 'system') {
    const message = asRecord(record.message)
    const content = message?.content
    const defaultRole = kind === 'assistant' ? 'assistant' : kind
    return normalizeContent(content, defaultRole, timestamp)
  }

  return [
    {
      role: 'system',
      text: `[unsupported: ${kind}]`,
      ts: timestamp,
      raw: { kind }
    }
  ]
}

function normalizeContent(
  content: unknown,
  defaultRole: 'user' | 'assistant' | 'system',
  timestamp: string | undefined
): DraftMessage[] {
  if (typeof content === 'string') {
    return content
      ? [{ role: defaultRole, text: content, ts: timestamp, raw: { kind: defaultRole } }]
      : []
  }
  if (!Array.isArray(content)) return []

  const messages: DraftMessage[] = []
  for (const value of content) {
    const block = asRecord(value)
    if (!block) continue
    const kind = asString(block.type) ?? 'unknown-block'

    if (kind === 'text' || kind === 'thinking') {
      const text = asString(block.text) ?? asString(block.thinking)
      if (text) {
        messages.push({
          role: defaultRole,
          text,
          ts: timestamp,
          raw: { kind }
        })
      }
      continue
    }

    if (kind === 'tool_use') {
      const toolName = asString(block.name) ?? 'unknown'
      messages.push({
        role: 'tool',
        text: `[tool: ${toolName}] ${compactJson(block.input)}`,
        toolName,
        ts: timestamp,
        raw: { kind }
      })
      continue
    }

    if (kind === 'tool_result') {
      const text = firstTextContent(block.content) ?? compactJson(block.content)
      messages.push({
        role: 'tool',
        text,
        ts: timestamp,
        raw: { kind }
      })
      continue
    }

    messages.push({
      role: 'system',
      text: `[unsupported: ${kind}]`,
      ts: timestamp,
      raw: { kind }
    })
  }
  return messages
}

function firstTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    const block = asRecord(value)
    const text = asString(block?.text) ?? asString(block?.content)
    if (text) return text
  }
  return undefined
}

// 仅取人类输入文本：字符串内容直取；数组内容只看 type==='text' 块，跳过 tool_result/tool_use/image。
function firstHumanUserText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    const block = asRecord(value)
    if (asString(block?.type) !== 'text') continue
    const text = asString(block?.text)
    if (text) return text
  }
  return undefined
}
