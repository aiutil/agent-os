import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type {
  AdapterSessionStorage,
  NormalizedMessage,
  NormalizedTranscript,
  SessionFileRef
} from '@shared/types'
import { asRecord, asString, compactJson } from '../storage-utils'
import { deriveTranscriptTitle, isHumanTranscriptText } from '@shared/transcript/title'

const DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
const DATA_ROOT = dirname(DB_PATH)

interface SessionRow {
  id: string
  directory: string
  title: string
  time_created: number
  time_updated: number
}

interface MessageRow {
  id: string
  time_created: number
  data: string
}

interface PartRow {
  message_id: string
  data: string
}

export const opencodeSessionStorage: AdapterSessionStorage = {
  support: 'full',
  incremental: false,
  // 同时监听主库与 WAL；读取连接可能触碰 SHM，因此不监听 SHM，避免自触发重扫。
  rootDirs: () => [DB_PATH, `${DB_PATH}-wal`],
  locateDir() {
    return existsSync(DB_PATH) ? DATA_ROOT : null
  },
  listSessionFiles() {
    return []
  },
  listNativeSessions() {
    return listOpenCodeSessions(DB_PATH)
  },
  async *scanTranscripts() {
    yield* scanOpenCodeTranscripts(DB_PATH)
  }
}

export function listOpenCodeSessions(databasePath: string): SessionFileRef[] {
  if (!existsSync(databasePath)) return []
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    return (
      database
        .prepare(
          `SELECT id, directory, time_created, time_updated
           FROM session ORDER BY time_updated DESC`
        )
        .all() as Array<Omit<SessionRow, 'title'>>
    ).map((session) => ({
      path: `${databasePath}#${session.id}`,
      nativeSessionId: session.id,
      toolId: 'opencode',
      cwd: session.directory || undefined,
      createdAt: normalizeEpochMs(session.time_created),
      mtime: normalizeEpochMs(session.time_updated)
    }))
  } finally {
    database.close()
  }
}

export async function* scanOpenCodeTranscripts(
  databasePath: string
): AsyncIterable<NormalizedTranscript> {
    if (!existsSync(databasePath)) return
    const database = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      const sessions = database
        .prepare(
          `SELECT id, directory, title, time_created, time_updated
           FROM session ORDER BY time_updated DESC`
        )
        .all() as SessionRow[]
      const messageStatement = database.prepare(
        `SELECT id, time_created, data
         FROM message WHERE session_id = ? ORDER BY time_created, id`
      )
      const partStatement = database.prepare(
        `SELECT message_id, data
         FROM part WHERE session_id = ? ORDER BY time_created, id`
      )

      for (const session of sessions) {
        const partRows = partStatement.all(session.id) as PartRow[]
        const partsByMessage = new Map<string, Record<string, unknown>[]>()
        for (const row of partRows) {
          const parsed = parseJson(row.data)
          if (!parsed) continue
          const values = partsByMessage.get(row.message_id) ?? []
          values.push(parsed)
          partsByMessage.set(row.message_id, values)
        }

        let parseErrors = 0
        const messages: NormalizedMessage[] = []
        for (const row of messageStatement.all(session.id) as MessageRow[]) {
          const data = parseJson(row.data)
          if (!data) {
            parseErrors += 1
            continue
          }
          const role = normalizeRole(data.role)
          const timestamp = epochMsToIso(
            asRecord(data.time)?.created ?? row.time_created
          )
          const parts = partsByMessage.get(row.id) ?? []
          for (const message of normalizeParts(role, timestamp, parts)) {
            messages.push({ ...message, seq: messages.length })
          }
        }

        yield {
          nativeSessionId: session.id,
          toolId: 'opencode',
          cwd: session.directory || null,
          title: deriveTranscriptTitle({
            preferred: session.title,
            firstHumanText: messages.find((item) => item.role === 'user' && isHumanTranscriptText(item.text))?.text,
            fallback: session.id
          }),
          startedAt: epochMsToIso(session.time_created) ?? null,
          lastActivityAt: epochMsToIso(session.time_updated) ?? null,
          messages,
          parseErrors
        } satisfies NormalizedTranscript
      }
    } finally {
      database.close()
    }
  }

function normalizeParts(
  role: NormalizedMessage['role'],
  ts: string | undefined,
  parts: Record<string, unknown>[]
): Array<Omit<NormalizedMessage, 'seq'>> {
  const messages: Array<Omit<NormalizedMessage, 'seq'>> = []
  for (const part of parts) {
    const kind = asString(part.type) ?? 'unknown'
    if (kind === 'text' || kind === 'reasoning') {
      const text = asString(part.text) ?? asString(part.reasoning)
      if (text) messages.push({ role, text, ts, raw: { kind } })
      continue
    }
    if (kind === 'tool') {
      const toolName = asString(part.tool) ?? 'unknown'
      const state = asRecord(part.state)
      messages.push({
        role: 'tool',
        text: `[tool: ${toolName}] ${compactJson(state?.input)}`,
        toolName,
        ts,
        raw: { kind: 'tool_call' }
      })
      const output = asString(state?.output) ?? asString(state?.error)
      if (output) {
        messages.push({
          role: 'tool',
          text: output,
          toolName,
          ts,
          raw: { kind: 'tool_result' }
        })
      }
    }
  }
  return messages
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value) as unknown)
  } catch {
    return undefined
  }
}

function normalizeRole(value: unknown): NormalizedMessage['role'] {
  if (value === 'user' || value === 'assistant' || value === 'tool') return value
  return 'system'
}

function epochMsToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString()
}

function normalizeEpochMs(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value
}
