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

const CLI_ROOT = join(homedir(), '.hermes', 'sessions')
const WEBUI_ROOT = join(homedir(), '.hermes', 'webui', 'sessions')

export const hermesSessionStorage: AdapterSessionStorage = {
  support: 'full',
  incremental: false,
  rootDirs: () => [CLI_ROOT, WEBUI_ROOT],
  locateDir() {
    if (existsSync(WEBUI_ROOT)) return WEBUI_ROOT
    return existsSync(CLI_ROOT) ? CLI_ROOT : null
  },
  listSessionFiles(dir) {
    return listTranscriptFiles(dir, 'hermes', ['.json', '.jsonl']).filter(
      (file) =>
        !basename(file.path).startsWith('request_dump_') &&
        basename(file.path) !== '_index.json' &&
        basename(file.path) !== 'expected.json'
    )
  },
  parseTranscript(path) {
    const parsed = parseHermesFile(path)
    return createArrayTranscriptStream(parsed.messages, parsed.parseErrors)
  },
  async readMeta(path) {
    const parsed = parseHermesFile(path)
    return {
      nativeSessionId: parsed.nativeSessionId,
      cwd: parsed.cwd,
      title: parsed.title,
      startedAt: parsed.startedAt
    } satisfies Pick<NormalizedTranscript, 'nativeSessionId' | 'cwd' | 'title' | 'startedAt'>
  }
}

function parseHermesFile(path: string): {
  nativeSessionId: string
  cwd: string | null
  title: string
  startedAt: string | null
  messages: DraftMessage[]
  parseErrors: number
} {
  const raw = readFileSync(path, 'utf8')
  let records: Record<string, unknown>[] = []
  let metadata: Record<string, unknown> = {}
  let parseErrors = 0

  try {
    const root = JSON.parse(raw) as unknown
    if (Array.isArray(root)) {
      records = root.flatMap((value) => {
        const record = asRecord(value)
        return record ? [record] : []
      })
    } else {
      const record = asRecord(root)
      if (!record) throw new Error('Hermes session root is not an object')
      metadata = record
      records = Array.isArray(record.messages)
        ? record.messages.flatMap((value) => {
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
        if (value) records.push(value)
        else parseErrors += 1
      } catch {
        parseErrors += 1
      }
    }
  }

  const nativeSessionId =
    asString(metadata.session_id) ??
    asString(metadata.sessionId) ??
    basename(path, extname(path)).replace(/^session_/, '')
  const cwd =
    asString(metadata.cwd) ??
    asString(metadata.workspace) ??
    asString(metadata.workspacePath) ??
    null
  const startedAt =
    asString(metadata.session_start) ??
    asString(metadata.created_at) ??
    timestampOf(records[0]) ??
    null
  const messages = records.flatMap(parseHermesMessage)
  const firstUser = messages.find((message) => message.role === 'user' && isHumanTranscriptText(message.text))?.text

  return {
    nativeSessionId,
    cwd,
    title: deriveTranscriptTitle({
      preferred: asString(metadata.title),
      firstHumanText: firstUser,
      fallback: fallbackTitle(path)
    }),
    startedAt,
    messages,
    parseErrors
  }
}

function parseHermesMessage(record: Record<string, unknown>): DraftMessage[] {
  const role = normalizeRole(record.role)
  if (role === 'system' && record.role === 'session_meta') return []
  const ts = timestampOf(record)
  const content = record.content ?? asRecord(record.message)?.content
  const messages: DraftMessage[] = []

  const text = textOf(content)
  if (text) messages.push({ role, text, ts, raw: { kind: String(record.role ?? 'message') } })

  const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : []
  for (const item of toolCalls) {
    const call = asRecord(item)
    const fn = asRecord(call?.function)
    const toolName = asString(fn?.name) ?? asString(call?.name) ?? 'unknown'
    messages.push({
      role: 'tool',
      text: `[tool: ${toolName}] ${compactJson(fn?.arguments ?? call?.arguments)}`,
      toolName,
      ts,
      raw: { kind: 'tool_call' }
    })
  }
  return messages
}

function normalizeRole(value: unknown): DraftMessage['role'] {
  if (value === 'user' || value === 'assistant' || value === 'tool') return value
  return 'system'
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

function timestampOf(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined
  return (
    asString(record.timestamp) ??
    asString(record.created_at) ??
    asString(asRecord(record.time)?.created)
  )
}
