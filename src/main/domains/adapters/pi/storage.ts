import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { AdapterSessionStorage, NormalizedTranscript } from '@shared/types'
import {
  asRecord,
  asString,
  compactJson,
  createArrayTranscriptStream,
  fallbackTitle,
  listTranscriptFiles,
  type DraftMessage
} from '../storage-utils'
import { deriveTranscriptTitle, isHumanTranscriptText } from '@shared/transcript/title'

const ROOT = join(homedir(), '.pi', 'agent', 'sessions')

export const piSessionStorage: AdapterSessionStorage = {
  support: 'full',
  incremental: false,
  rootDirs: () => [ROOT],
  locateDir() {
    return existsSync(ROOT) ? ROOT : null
  },
  listSessionFiles(dir) {
    return listTranscriptFiles(dir, 'pi', ['.json', '.jsonl']).filter(
      (file) => basename(file.path) !== 'expected.json'
    )
  },
  parseTranscript(path) {
    const parsed = parsePiFile(path)
    return createArrayTranscriptStream(parsed.messages, parsed.parseErrors)
  },
  async readMeta(path) {
    const parsed = parsePiFile(path)
    return {
      nativeSessionId: parsed.nativeSessionId,
      cwd: parsed.cwd,
      title: parsed.title,
      startedAt: parsed.startedAt
    } satisfies Pick<NormalizedTranscript, 'nativeSessionId' | 'cwd' | 'title' | 'startedAt'>
  }
}

function parsePiFile(path: string): {
  nativeSessionId: string
  cwd: string | null
  title: string
  startedAt: string | null
  messages: DraftMessage[]
  parseErrors: number
} {
  const raw = readFileSync(path, 'utf8')
  let root: Record<string, unknown> = {}
  let records: Record<string, unknown>[] = []
  let parseErrors = 0
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      records = parsed.flatMap((value) => {
        const record = asRecord(value)
        return record ? [record] : []
      })
    } else {
      const record = asRecord(parsed)
      if (!record) throw new Error('Pi session root is not an object')
      root = record
      const nested = record.messages ?? record.history
      records = Array.isArray(nested)
        ? nested.flatMap((value) => {
            const message = asRecord(value)
            return message ? [message] : []
          })
        : []
    }
  } catch {
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as unknown
        const value = asRecord(record)
        if (value) {
          if (value.type === 'session' || value.type === 'session_meta') root = value
          else records.push(value)
        } else parseErrors += 1
      } catch {
        parseErrors += 1
      }
    }
  }

  const messages = records.flatMap(parsePiMessage)
  const firstUser = messages.find((message) => message.role === 'user' && isHumanTranscriptText(message.text))?.text

  return {
    nativeSessionId:
      asString(root.id) ??
      asString(root.session_id) ??
      asString(root.sessionId) ??
      basename(path, extname(path)),
    cwd:
      asString(root.cwd) ??
      asString(root.directory) ??
      asString(root.workspace) ??
      asString(root.workspacePath) ??
      null,
    title: deriveTranscriptTitle({
      preferred: asString(root.title) ?? asString(root.summary),
      firstHumanText: firstUser,
      fallback: fallbackTitle(path)
    }),
    startedAt: normalizeTimestamp(
      root.time_created ?? root.created_at ?? root.createdAt ?? root.timestamp
    ) ?? messages.find((message) => message.ts)?.ts ?? null,
    messages,
    parseErrors
  }
}

function normalizeRole(value: unknown): DraftMessage['role'] {
  if (value === 'user' || value === 'assistant' || value === 'tool') return value
  return 'system'
}

function parsePiMessage(record: Record<string, unknown>): DraftMessage[] {
  // Pi v3 把角色嵌在 record.message.role；顶层 record.type 恒为 'message'，
  // 直接用它会把所有消息误判成 system，导致首句标题（需 role==='user'）永远取不到。
  const role = normalizeRole(record.role ?? asRecord(record.message)?.role ?? record.type)
  const timestamp = normalizeTimestamp(
    record.timestamp ?? record.created_at ?? asRecord(record.time)?.created
  )
  const content = record.content ?? record.text ?? asRecord(record.message)?.content
  const rawKind = String(record.type ?? record.role ?? 'message')

  if (typeof content === 'string') {
    return content ? [{ role, text: content, ts: timestamp, raw: { kind: rawKind } }] : []
  }

  if (!Array.isArray(content)) return []

  const messages: DraftMessage[] = []
  for (const value of content) {
    if (typeof value === 'string') {
      messages.push({ role, text: value, ts: timestamp, raw: { kind: rawKind } })
      continue
    }

    const block = asRecord(value)
    if (!block) continue
    const kind = asString(block.type) ?? rawKind

    if (kind === 'text' || kind === 'thinking') {
      const text = asString(block.text) ?? asString(block.thinking) ?? asString(block.content)
      if (text) messages.push({ role, text, ts: timestamp, raw: { kind } })
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
      const text = textOf(block.content ?? block.text ?? block.output) ?? compactJson(block.content ?? block.output)
      messages.push({
        role: 'tool',
        text,
        ts: timestamp,
        raw: { kind }
      })
      continue
    }

    const text = asString(block.text) ?? asString(block.content)
    if (text) messages.push({ role, text, ts: timestamp, raw: { kind } })
  }

  return messages
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap((item) => {
    if (typeof item === 'string') return [item]
    const record = asRecord(item)
    const text = asString(record?.text) ?? asString(record?.content)
    return text ? [text] : []
  })
  return parts.length ? parts.join('\n') : undefined
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number') {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value
    return new Date(milliseconds).toISOString()
  }
  if (typeof value !== 'string' || !value) return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined
}
