import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { CliAdapter } from '../adapters/types'
import type {
  CurationCandidate,
  CurationCandidateInput,
  IndexedFileState,
  MemoryInSessionSearchInput,
  MemoryIndexStatus,
  MemorySearchHit,
  MemorySearchInput,
  MemoryTranscriptMeta,
  MemoryTranscriptPage,
  MemoryTranscriptPageInput,
  NormalizedMessage,
  NormalizedTranscript,
  StatsActivity,
  StatsBreakdownItem,
  StatsDashboard,
  StatsGrowth,
  StatsModels,
  StatsProjectOption,
  StatsQuery,
  StatsSummary,
  StatsTrendPoint,
  TranscriptUsageFact
} from '@shared/types'
import { UNASSIGNED_STATS_PROJECT_KEY } from '@shared/types'
import { estimateUsageCost } from '../stats/pricing'
import { calculateGrowth } from '../stats/growth'

const MAX_INDEXED_MESSAGE_LENGTH = 32 * 1024
const MAX_HOT_MAIN_LENGTH = 8 * 1024
const MAX_HOT_TOOL_LENGTH = 2 * 1024
const READ_CHUNK_SIZE = 64 * 1024
const OPEN_MARK = '\u0001'
const CLOSE_MARK = '\u0002'

interface SessionRow {
  id: string
  nativeSessionId: string
  toolId: string
  cwd: string | null
  title: string
  startedAt: string | null
  lastActivityAt: string
  parseErrors: number
  messageCount: number
}

interface MessageRow {
  seq: number
  role: NormalizedMessage['role']
  content: string
  toolName: string | null
  ts: string | null
  rawKind: string | null
}

interface BackfillMessageRow extends MessageRow {
  id: number
  sessionId: string
  title: string
}

interface SearchRow extends SessionRow {
  snippet: string
  rank: number
}

interface AggregateRow {
  key: string
  sessions: number
  prompts: number
  tokens: number
  estimatedCostUsd: number | null
  unpricedFacts: number
  pricedFacts: number
}

function safeDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  try {
    const database = new Database(path)
    database.prepare('SELECT name FROM sqlite_master LIMIT 1').get()
    return database
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      // 文件可能在打开失败前并不存在。
    }
    return new Database(path)
  }
}

// 解析器/schema 版本。改动任何 adapter 的 transcript 解析逻辑（如角色归类、标题派生）
// 后递增此值，启动时会清空 indexed_files 指纹，强制下次 reconcile 全量重解析旧文件。
const INDEX_SCHEMA_VERSION = 25

function initializeSchema(database: Database.Database): void {
  database.pragma('journal_mode = WAL')
  const previousVersion = Number(database.pragma('user_version', { simple: true }) ?? 0)
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      nativeSessionId TEXT NOT NULL,
      toolId TEXT NOT NULL,
      cwd TEXT,
      title TEXT NOT NULL,
      startedAt TEXT,
      lastActivityAt TEXT NOT NULL,
      sourcePath TEXT NOT NULL UNIQUE,
      parseErrors INTEGER NOT NULL DEFAULT 0,
      messageCount INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      toolName TEXT,
      ts TEXT,
      rawKind TEXT,
      UNIQUE(sessionId, seq)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_hot_fts USING fts5(
      messageId UNINDEXED,
      sessionId UNINDEXED,
      seq UNINDEXED,
      role UNINDEXED,
      content,
      title,
      tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS hot_indexed_messages (
      messageId INTEGER PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS message_index_meta (
      messageId INTEGER PRIMARY KEY,
      contentLength INTEGER NOT NULL,
      contentHash TEXT NOT NULL,
      hotLength INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indexed_files (
      path TEXT PRIMARY KEY,
      byteOffset INTEGER NOT NULL,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS usage_facts (
      sessionId TEXT NOT NULL,
      factKey TEXT NOT NULL,
      model TEXT,
      ts TEXT,
      inputTokens INTEGER NOT NULL,
      outputTokens INTEGER NOT NULL,
      cacheWriteTokens INTEGER NOT NULL,
      cacheReadTokens INTEGER NOT NULL,
      estimatedCostUsd REAL,
      PRIMARY KEY(sessionId, factKey)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(lastActivityAt DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd_activity ON sessions(cwd, lastActivityAt DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_id_session ON messages(id, sessionId);
    CREATE INDEX IF NOT EXISTS idx_messages_role_ts_session ON messages(role, ts, sessionId);
    CREATE INDEX IF NOT EXISTS idx_usage_facts_session ON usage_facts(sessionId, ts);
    CREATE INDEX IF NOT EXISTS idx_usage_facts_ts_session ON usage_facts(ts, sessionId);
    CREATE INDEX IF NOT EXISTS idx_usage_facts_model_ts ON usage_facts(model, ts);
  `)
  // 版本变化 → 作废文件指纹，强制全量重解析（派生缓存，重建安全；
  // rebuild 路径会先删旧会话内容，无重复）。
  if (previousVersion !== INDEX_SCHEMA_VERSION) {
    database.exec('DELETE FROM indexed_files')
    database.pragma(`user_version = ${INDEX_SCHEMA_VERSION}`)
  }
}

function lastCompleteLineOffset(path: string): number {
  const size = statSync(path).size
  if (size === 0) return 0
  const fd = openSync(path, 'r')
  try {
    let cursor = size
    while (cursor > 0) {
      const length = Math.min(READ_CHUNK_SIZE, cursor)
      cursor -= length
      const buffer = Buffer.allocUnsafe(length)
      readSync(fd, buffer, 0, length, cursor)
      const newline = buffer.lastIndexOf(0x0a)
      if (newline >= 0) return cursor + newline + 1
    }
    return 0
  } finally {
    closeSync(fd)
  }
}

function sessionId(toolId: string, nativeSessionId: string): string {
  return `${toolId}:${nativeSessionId}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeSnippet(value: string): string {
  return escapeHtml(value).replaceAll(OPEN_MARK, '<mark>').replaceAll(CLOSE_MARK, '</mark>')
}

function contentHash(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function hotSearchText(message: NormalizedMessage): string {
  const text = message.text.trim()
  if (!text) return ''
  if (message.role === 'tool') {
    return [
      message.toolName ? `tool ${message.toolName}` : 'tool',
      message.raw?.kind ?? '',
      text.slice(0, MAX_HOT_TOOL_LENGTH)
    ].filter(Boolean).join('\n')
  }
  if (message.role === 'system') {
    return text.slice(0, MAX_HOT_TOOL_LENGTH)
  }
  return text.slice(0, MAX_HOT_MAIN_LENGTH)
}

function metaFromSessionRow(row: SessionRow): MemoryTranscriptMeta {
  return {
    sessionId: row.id,
    nativeSessionId: row.nativeSessionId,
    toolId: row.toolId,
    cwd: row.cwd,
    title: row.title,
    startedAt: row.startedAt,
    lastActivityAt: row.lastActivityAt,
    parseErrors: row.parseErrors,
    messageCount: row.messageCount
  }
}

function isoFromMtime(mtime: number): string {
  return new Date(mtime).toISOString()
}

function termsOf(query: string): string[] {
  return query
    .trim()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter(Boolean)
}

function ftsExpression(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ')
}

export class MemoryIndex {
  private readonly database: Database.Database
  private status: MemoryIndexStatus = {
    filesTotal: 0,
    filesIndexed: 0,
    building: false,
    failedFiles: []
  }

  constructor(readonly path: string) {
    this.database = safeDatabase(path)
    initializeSchema(this.database)
  }

  close(): void {
    this.database.close()
  }

  getStatus(): MemoryIndexStatus {
    return structuredClone(this.status)
  }

  setStatus(status: MemoryIndexStatus): void {
    this.status = structuredClone(status)
  }

  getIndexedFile(path: string): IndexedFileState | null {
    return (
      (this.database
        .prepare(
          `SELECT path, byteOffset, mtime, size, status, error
           FROM indexed_files WHERE path = ?`
        )
        .get(path) as IndexedFileState | undefined) ?? null
    )
  }

  listIndexedFiles(): IndexedFileState[] {
    return this.database
      .prepare(
        `SELECT path, byteOffset, mtime, size, status, error
         FROM indexed_files ORDER BY path`
      )
      .all() as IndexedFileState[]
  }

  removeFile(path: string): void {
    this.database.transaction(() => {
      const session = this.database
        .prepare('SELECT id FROM sessions WHERE sourcePath = ?')
        .get(path) as { id: string } | undefined
      if (session) this.deleteSessionContent(session.id)
      this.database.prepare('DELETE FROM indexed_files WHERE path = ?').run(path)
    })()
  }

  async indexFile(adapter: CliAdapter, path: string): Promise<void> {
    const storage = adapter.sessionStorage
    if (!storage?.parseTranscript || !storage.readMeta) return

    const stat = statSync(path)
    const completeOffset = lastCompleteLineOffset(path)
    const previous = this.getIndexedFile(path)
    if (
      previous?.status === 'indexed' &&
      previous.byteOffset === completeOffset &&
      previous.size === stat.size &&
      previous.mtime === stat.mtimeMs
    ) {
      return
    }

    const rebuild =
      storage.incremental === false || !previous || completeOffset < previous.byteOffset
    const startOffset = rebuild ? 0 : previous.byteOffset
    if (completeOffset === startOffset && previous) {
      this.recordIndexedFile(path, completeOffset, stat.mtimeMs, stat.size)
      return
    }

    try {
      const meta = await storage.readMeta(path)
      const id = sessionId(adapter.id, meta.nativeSessionId)
      const stream = storage.parseTranscript(path, { startOffset })
      const messages: NormalizedMessage[] = []
      for await (const message of stream) messages.push(message)
      const summary = await stream.summary
      const usageFacts = await stream.usageFacts
      const nextSeq = rebuild
        ? 0
        : (
            this.database
              .prepare(
                'SELECT COALESCE(MAX(seq), -1) + 1 AS value FROM messages WHERE sessionId = ?'
              )
              .get(id) as { value: number }
          ).value
      const normalized = messages.map((message, index) => ({
        ...message,
        seq: nextSeq + index,
        text: message.text.slice(0, MAX_INDEXED_MESSAGE_LENGTH)
      }))
      const latestTimestamp =
        normalized
          .map((message) => message.ts)
          .filter(Boolean)
          .sort()
          .at(-1) ?? isoFromMtime(stat.mtimeMs)

      this.database.transaction(() => {
        if (rebuild) {
          const prior = this.database
            .prepare('SELECT id FROM sessions WHERE sourcePath = ?')
            .get(path) as { id: string } | undefined
          if (prior) this.deleteSessionContent(prior.id)
          if (prior?.id !== id) this.deleteSessionContent(id)
        }
        this.database
          .prepare(
            `INSERT INTO sessions (
              id, nativeSessionId, toolId, cwd, title, startedAt,
              lastActivityAt, sourcePath, parseErrors, messageCount
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              cwd=excluded.cwd,
              title=excluded.title,
              startedAt=excluded.startedAt,
              lastActivityAt=MAX(sessions.lastActivityAt, excluded.lastActivityAt),
              sourcePath=excluded.sourcePath,
              parseErrors=sessions.parseErrors + excluded.parseErrors,
              messageCount=sessions.messageCount + excluded.messageCount`
          )
          .run(
            id,
            meta.nativeSessionId,
            adapter.id,
            meta.cwd,
            meta.title,
            meta.startedAt,
            latestTimestamp,
            path,
            summary.parseErrors,
            normalized.length
          )

        const insertMessage = this.database.prepare(
          `INSERT INTO messages (
            sessionId, seq, role, content, toolName, ts, rawKind
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        const insertHotFts = this.database.prepare(
          `INSERT INTO messages_hot_fts (
            rowid, messageId, sessionId, seq, role, content, title
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        const insertHotState = this.database.prepare(
          'INSERT OR REPLACE INTO hot_indexed_messages (messageId) VALUES (?)'
        )
        const insertMeta = this.database.prepare(
          `INSERT OR REPLACE INTO message_index_meta (
            messageId, contentLength, contentHash, hotLength
          ) VALUES (?, ?, ?, ?)`
        )
        for (const message of normalized) {
          const info = insertMessage.run(
            id,
            message.seq,
            message.role,
            message.text,
            message.toolName ?? null,
            message.ts ?? null,
            message.raw?.kind ?? null
          )
          const messageId = Number(info.lastInsertRowid)
          const hot = hotSearchText(message)
          insertMeta.run(messageId, message.text.length, contentHash(message.text), hot.length)
          if (hot) {
            insertHotFts.run(messageId, messageId, id, message.seq, message.role, hot, meta.title)
            insertHotState.run(messageId)
          }
        }
        this.upsertUsageFacts(id, usageFacts)
        this.recordIndexedFile(path, completeOffset, stat.mtimeMs, stat.size)
      })()
    } catch (error) {
      this.database
        .prepare(
          `INSERT INTO indexed_files (path, byteOffset, mtime, size, status, error)
           VALUES (?, 0, ?, ?, 'failed', ?)
           ON CONFLICT(path) DO UPDATE SET
             mtime=excluded.mtime, size=excluded.size, status='failed', error=excluded.error`
        )
        .run(path, stat.mtimeMs, stat.size, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  upsertTranscript(toolId: string, sourcePath: string, transcript: NormalizedTranscript): void {
    const id = sessionId(toolId, transcript.nativeSessionId)
    const normalized = transcript.messages.map((message, index) => ({
      ...message,
      seq: index,
      text: message.text.slice(0, MAX_INDEXED_MESSAGE_LENGTH)
    }))
    const latestTimestamp =
      transcript.lastActivityAt ??
      normalized
        .map((message) => message.ts)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ??
      transcript.startedAt ??
      new Date(0).toISOString()

    this.database.transaction(() => {
      const prior = this.database
        .prepare('SELECT id FROM sessions WHERE sourcePath = ? OR id = ?')
        .get(sourcePath, id) as { id: string } | undefined
      if (prior) this.deleteSessionContent(prior.id)

      this.database
        .prepare(
          `INSERT INTO sessions (
            id, nativeSessionId, toolId, cwd, title, startedAt,
            lastActivityAt, sourcePath, parseErrors, messageCount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          transcript.nativeSessionId,
          toolId,
          transcript.cwd,
          transcript.title,
          transcript.startedAt,
          latestTimestamp,
          sourcePath,
          transcript.parseErrors,
          normalized.length
        )

      const insertMessage = this.database.prepare(
        `INSERT INTO messages (
          sessionId, seq, role, content, toolName, ts, rawKind
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      const insertHotFts = this.database.prepare(
        `INSERT INTO messages_hot_fts (
          rowid, messageId, sessionId, seq, role, content, title
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      const insertHotState = this.database.prepare(
        'INSERT OR REPLACE INTO hot_indexed_messages (messageId) VALUES (?)'
      )
      const insertMeta = this.database.prepare(
        `INSERT OR REPLACE INTO message_index_meta (
          messageId, contentLength, contentHash, hotLength
        ) VALUES (?, ?, ?, ?)`
      )
      for (const message of normalized) {
        const info = insertMessage.run(
          id,
          message.seq,
          message.role,
          message.text,
          message.toolName ?? null,
          message.ts ?? null,
          message.raw?.kind ?? null
        )
        const messageId = Number(info.lastInsertRowid)
        const hot = hotSearchText(message)
        insertMeta.run(messageId, message.text.length, contentHash(message.text), hot.length)
        if (hot) {
          insertHotFts.run(messageId, messageId, id, message.seq, message.role, hot, transcript.title)
          insertHotState.run(messageId)
        }
      }
      this.recordIndexedFile(sourcePath, normalized.length, Date.now(), normalized.length)
    })()
  }

  search(input: MemorySearchInput): MemorySearchHit[] {
    const terms = termsOf(input.query)
    const longTerms = terms.filter((term) => Array.from(term).length >= 3)
    const shortTerms = terms.filter((term) => Array.from(term).length < 3)
    const filters: string[] = []
    const params: unknown[] = []
    if (input.toolIds?.length) {
      filters.push(`s.toolId IN (${input.toolIds.map(() => '?').join(',')})`)
      params.push(...input.toolIds)
    }
    if (input.workspacePath) {
      filters.push('s.cwd = ?')
      params.push(input.workspacePath)
    }
    if (input.sessionId || input.scope === 'session') {
      filters.push('s.id = ?')
      params.push(input.sessionId ?? '')
    }
    if (input.dateRange?.from) {
      filters.push('s.lastActivityAt >= ?')
      params.push(input.dateRange.from)
    }
    if (input.dateRange?.to) {
      filters.push('s.lastActivityAt <= ?')
      params.push(input.dateRange.to)
    }
    for (const term of shortTerms) {
      filters.push(input.deep
        ? `EXISTS (
            SELECT 1 FROM messages sm
            WHERE sm.sessionId = s.id
              AND (LOWER(sm.content) LIKE LOWER(?) OR LOWER(s.title) LIKE LOWER(?))
          )`
        : `EXISTS (
            SELECT 1 FROM messages_hot_fts hf
            WHERE hf.sessionId = s.id
              AND (LOWER(hf.content) LIKE LOWER(?) OR LOWER(s.title) LIKE LOWER(?))
          )`
      )
      params.push(`%${term}%`, `%${term}%`)
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(input.limit || 50, 200))

    let rows: SearchRow[]
    if (longTerms.length > 0 && !input.deep) {
      const matchedRows = this.database
        .prepare(
          `SELECT
            s.*,
            snippet(messages_hot_fts, 4, '${OPEN_MARK}', '${CLOSE_MARK}', '…', 24) AS snippet,
            bm25(messages_hot_fts, 0, 0, 0, 0, 1, 4) AS rank
          FROM messages_hot_fts
          JOIN sessions s ON s.id = messages_hot_fts.sessionId
          ${where ? `${where} AND messages_hot_fts MATCH ?` : 'WHERE messages_hot_fts MATCH ?'}
          ORDER BY (-bm25(messages_hot_fts, 0, 0, 0, 0, 1, 4))
            + (julianday(s.lastActivityAt) / 1000000.0) DESC
          LIMIT ?`
        )
        .all(...params, ftsExpression(longTerms), limit * 20) as SearchRow[]
      const seen = new Set<string>()
      rows = matchedRows
        .filter((row) => {
          if (seen.has(row.id)) return false
          seen.add(row.id)
          return true
        })
        .slice(0, limit)
    } else if (terms.length > 0) {
      const table = input.deep ? 'messages' : 'messages_hot_fts'
      rows = this.database
        .prepare(
          `SELECT s.*,
            COALESCE((
              SELECT content FROM ${table} sm
              WHERE sm.sessionId = s.id
                AND LOWER(sm.content) LIKE LOWER(?)
              ORDER BY sm.seq LIMIT 1
            ), s.title) AS snippet,
            0 AS rank
          FROM sessions s
          ${where}
          ORDER BY s.lastActivityAt DESC
          LIMIT ?`
        )
        .all(`%${terms[0]}%`, ...params, limit) as SearchRow[]
    } else {
      rows = this.database
        .prepare(
          `SELECT s.*, s.title AS snippet, 0 AS rank
           FROM sessions s ${where}
           ORDER BY s.lastActivityAt DESC LIMIT ?`
        )
        .all(...params, limit) as SearchRow[]
    }

    return rows.map((row) => ({
      sessionId: row.id,
      nativeSessionId: row.nativeSessionId,
      toolId: row.toolId,
      title: row.title,
      cwd: row.cwd,
      snippetHtml: safeSnippet(row.snippet),
      lastActivityAt: row.lastActivityAt,
      score: -row.rank,
      messageCount: row.messageCount
    }))
  }

  /**
   * 单会话内正文检索（会话内搜索）。按 sessionId 收敛到一个会话再 LIKE 命中，覆盖整段会话而非已加载页。
   * 单会话范围有界（受 (sessionId, seq) 索引收敛），不依赖 trigram，1-2 个 CJK 字也能命中。
   */
  searchInSession(input: MemoryInSessionSearchInput): NormalizedTranscript['messages'] {
    const trimmed = input.query.trim()
    if (!trimmed) return []
    const terms = trimmed
      .split(/\s+/u)
      .map((t) => t.trim())
      .filter(Boolean)
    if (terms.length === 0) return []
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000))
    const where = terms.map(() => 'LOWER(content) LIKE LOWER(?)').join(' AND ')
    const rows = this.database
      .prepare(
        `SELECT seq, role, content, toolName, ts, rawKind
         FROM messages
         WHERE sessionId = ? AND ${where}
         ORDER BY seq ASC LIMIT ?`
      )
      .all(input.sessionId, ...terms.map((t) => `%${t}%`), limit) as MessageRow[]
    return rows.map((row) => ({
      seq: row.seq,
      role: row.role,
      text: row.content,
      ...(row.toolName ? { toolName: row.toolName } : {}),
      ...(row.ts ? { ts: row.ts } : {}),
      ...(row.rawKind ? { raw: { kind: row.rawKind } } : {})
    }))
  }

  /**
   * 后台自动提炼候选：已空闲（lastActivityAt 早于 idleBeforeIso）且仍在提炼纪元之后
   * （lastActivityAt 不早于 sinceIso）、有工作目录、含用户消息的会话，按最近活跃排序。
   * 增量去重（对比水位线）由调用方在 vault 侧完成，这里只做范围收敛。
   */
  listCurationCandidates(input: CurationCandidateInput): CurationCandidate[] {
    const limit = Math.max(1, Math.min(input.limit, 200))
    const rows = this.database
      .prepare(
        `SELECT id, toolId, cwd, title, messageCount, lastActivityAt
         FROM sessions
         WHERE lastActivityAt < ?
           AND lastActivityAt >= ?
           AND cwd IS NOT NULL AND cwd <> ''
           AND messageCount > 0
         ORDER BY lastActivityAt DESC
         LIMIT ?`
      )
      .all(input.idleBeforeIso, input.sinceIso, limit) as Array<{
      id: string
      toolId: string
      cwd: string | null
      title: string
      messageCount: number
      lastActivityAt: string
    }>
    return rows.map((row) => ({
      sessionId: row.id,
      toolId: row.toolId,
      cwd: row.cwd,
      title: row.title,
      messageCount: row.messageCount,
      lastActivityAt: row.lastActivityAt
    }))
  }

  getTranscript(id: string): NormalizedTranscript | null {
    const session = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined
    if (!session) return null
    const rows = this.database
      .prepare(
        `SELECT seq, role, content, toolName, ts, rawKind
         FROM messages WHERE sessionId = ? ORDER BY seq`
      )
      .all(id) as MessageRow[]
    return {
      nativeSessionId: session.nativeSessionId,
      toolId: session.toolId,
      cwd: session.cwd,
      title: session.title,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      messages: rows.map((row, index) => ({
        seq: index,
        role: row.role,
        text: row.content,
        ...(row.toolName ? { toolName: row.toolName } : {}),
        ...(row.ts ? { ts: row.ts } : {}),
        ...(row.rawKind ? { raw: { kind: row.rawKind } } : {})
      })),
      parseErrors: session.parseErrors
    }
  }

  getTranscriptMeta(id: string): MemoryTranscriptMeta | null {
    const session = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined
    return session ? metaFromSessionRow(session) : null
  }

  getTranscriptPage(input: MemoryTranscriptPageInput): MemoryTranscriptPage | null {
    const meta = this.getTranscriptMeta(input.sessionId)
    if (!meta) return null
    const limit = Math.max(1, Math.min(input.limit ?? 150, 500))
    const direction = input.direction ?? 'latest'
    let rows: MessageRow[]

    if (direction === 'before') {
      const cursor = input.cursor ?? Number.MAX_SAFE_INTEGER
      rows = (this.database
        .prepare(
          `SELECT seq, role, content, toolName, ts, rawKind
           FROM messages
           WHERE sessionId = ? AND seq < ?
           ORDER BY seq DESC LIMIT ?`
        )
        .all(input.sessionId, cursor, limit) as MessageRow[]).reverse()
    } else if (direction === 'after') {
      const cursor = input.cursor ?? -1
      rows = this.database
        .prepare(
          `SELECT seq, role, content, toolName, ts, rawKind
           FROM messages
           WHERE sessionId = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?`
        )
        .all(input.sessionId, cursor, limit) as MessageRow[]
    } else {
      rows = (this.database
        .prepare(
          `SELECT seq, role, content, toolName, ts, rawKind
           FROM messages
           WHERE sessionId = ?
           ORDER BY seq DESC LIMIT ?`
        )
        .all(input.sessionId, limit) as MessageRow[]).reverse()
    }

    const firstSeq = rows[0]?.seq ?? null
    const lastSeq = rows.at(-1)?.seq ?? null
    return {
      meta,
      messages: rows.map((row) => ({
        seq: row.seq,
        role: row.role,
        text: row.content,
        ...(row.toolName ? { toolName: row.toolName } : {}),
        ...(row.ts ? { ts: row.ts } : {}),
        ...(row.rawKind ? { raw: { kind: row.rawKind } } : {})
      })),
      hasMoreBefore: firstSeq !== null && firstSeq > 0,
      hasMoreAfter: lastSeq !== null && lastSeq < meta.messageCount - 1
    }
  }

  hotIndexProgress(): { indexed: number; total: number } {
    const indexed = (
      this.database
        .prepare('SELECT COUNT(*) AS value FROM hot_indexed_messages')
        .get() as { value: number }
    ).value
    const total = (
      this.database.prepare('SELECT COUNT(*) AS value FROM messages').get() as { value: number }
    ).value
    return { indexed, total }
  }

  backfillHotSearchIndexBatch(limit = 2_000): { indexed: number; total: number; done: boolean } {
    const rows = this.database
      .prepare(
        `SELECT
          m.id, m.sessionId, m.seq, m.role, m.content, m.toolName, m.ts, m.rawKind, s.title
         FROM messages m
         JOIN sessions s ON s.id = m.sessionId
         LEFT JOIN hot_indexed_messages h ON h.messageId = m.id
         WHERE h.messageId IS NULL
         ORDER BY m.id
         LIMIT ?`
      )
      .all(limit) as BackfillMessageRow[]

    if (rows.length > 0) {
      const insertHotFts = this.database.prepare(
        `INSERT INTO messages_hot_fts (
          rowid, messageId, sessionId, seq, role, content, title
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      const insertHotState = this.database.prepare(
        'INSERT OR REPLACE INTO hot_indexed_messages (messageId) VALUES (?)'
      )
      const insertMeta = this.database.prepare(
        `INSERT OR REPLACE INTO message_index_meta (
          messageId, contentLength, contentHash, hotLength
        ) VALUES (?, ?, ?, ?)`
      )
      this.database.transaction(() => {
        for (const row of rows) {
          const message: NormalizedMessage = {
            seq: row.seq,
            role: row.role,
            text: row.content,
            ...(row.toolName ? { toolName: row.toolName } : {}),
            ...(row.ts ? { ts: row.ts } : {}),
            ...(row.rawKind ? { raw: { kind: row.rawKind } } : {})
          }
          const hot = hotSearchText(message)
          insertMeta.run(row.id, row.content.length, contentHash(row.content), hot.length)
          if (hot) insertHotFts.run(row.id, row.id, row.sessionId, row.seq, row.role, hot, row.title)
          insertHotState.run(row.id)
        }
      })()
    }

    const progress = this.hotIndexProgress()
    return { ...progress, done: progress.indexed >= progress.total }
  }

  cleanupLegacySearchIndexIfSafe(): void {
    const progress = this.hotIndexProgress()
    if (progress.indexed < progress.total) return
    const legacy = this.database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'messages_fts'`
      )
      .get() as { name: string } | undefined
    if (!legacy) return
    this.database.exec('DROP TABLE IF EXISTS messages_fts')
    this.database.pragma('wal_checkpoint(TRUNCATE)')
    try {
      this.database.exec('PRAGMA incremental_vacuum(1000)')
    } catch {
      // incremental vacuum 依赖 auto_vacuum；失败不影响索引可用性。
    }
  }

  getStatsSummary(input: StatsQuery): StatsSummary {
    const overview = this.statsOverviewSummary(input)
    return {
      ...overview,
      byModel: this.statsModelBreakdown(input),
      modelTrend: this.statsModelTrend(input),
      trend: this.statsTrend(input)
    }
  }

  getStatsDashboard(input: StatsQuery): StatsDashboard {
    return {
      summary: this.statsOverviewSummary(input),
      activity: this.statsActivity(input, false),
      projects: this.getStatsProjects()
    }
  }

  getStatsModels(input: StatsQuery): StatsModels {
    return {
      tokens: this.statsUsageTotals(input).tokens,
      byModel: this.statsModelBreakdown(input),
      modelTrend: this.statsModelTrend(input)
    }
  }

  getStatsProjects(): StatsProjectOption[] {
    const rows = this.database
      .prepare(
        `SELECT s.cwd AS key, COUNT(*) AS sessions, MAX(s.lastActivityAt) AS lastActivityAt
         FROM sessions s
         WHERE s.cwd IS NOT NULL AND s.cwd <> ''
         GROUP BY s.cwd
         ORDER BY lastActivityAt DESC, sessions DESC`
      )
      .all() as Array<{ key: string; sessions: number; lastActivityAt: string | null }>
    return rows.map((row) => ({ key: row.key, label: row.key }))
  }

  private statsOverviewSummary(input: StatsQuery): StatsDashboard['summary'] {
    const filter = statsFilter(input)
    const sessionWhere = filter.clauses.length ? `WHERE ${filter.clauses.join(' AND ')}` : ''
    const sessionParams = filter.params
    const sessions = (
      this.database
        .prepare(`SELECT COUNT(*) AS value FROM sessions s ${sessionWhere}`)
        .get(...sessionParams) as { value: number }
    ).value
    const promptFilter = [...filter.clauses, `m.role = 'user'`]
    if (filter.from) promptFilter.push('m.ts >= ?')
    const promptParams = [...filter.params, ...(filter.from ? [filter.from] : [])]
    const prompts = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS value
           FROM messages m JOIN sessions s ON s.id = m.sessionId
           WHERE ${promptFilter.join(' AND ')}`
        )
        .get(...promptParams) as { value: number }
    ).value

    const usage = this.statsUsageTotals(input)

    return {
      sessions,
      prompts,
      tokens: usage.tokens,
      estimatedCostUsd: usage.pricedFacts > 0 ? usage.estimatedCostUsd : null,
      hasUnpricedUsage: usage.unpricedFacts > 0,
      byTool: this.statsBreakdown(input, 's.toolId'),
      byProject: this.statsBreakdown(
        input,
        `COALESCE(NULLIF(s.cwd, ''), '${UNASSIGNED_STATS_PROJECT_KEY}')`
      )
    }
  }

  getStatsActivity(input: StatsQuery): StatsActivity {
    return this.statsActivity(input, true)
  }

  private statsActivity(input: StatsQuery, includeToolBreakdown: boolean): StatsActivity {
    const filter = statsFilter(input)
    const clauses = [...filter.clauses, `m.role = 'user'`, 'm.ts IS NOT NULL']
    if (filter.from) clauses.push('m.ts >= ?')
    const params = [...filter.params, ...(filter.from ? [filter.from] : [])]
    const rows = this.database
      .prepare(
        `SELECT date(m.ts, 'localtime') AS date, COUNT(*) AS prompts
         FROM messages m JOIN sessions s ON s.id = m.sessionId
         WHERE ${clauses.join(' AND ')}
         GROUP BY date(m.ts, 'localtime') ORDER BY date`
      )
      .all(...params) as Array<{ date: string; prompts: number }>
    const days = completeActivityDays(rows, input.range)
    const activeDates = new Set(rows.filter((row) => row.prompts > 0).map((row) => row.date))
    const streaks = calculateStreaks(activeDates)
    return {
      days,
      activeDays: activeDates.size,
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
      totalPrompts: rows.reduce((sum, row) => sum + row.prompts, 0),
      byTool: includeToolBreakdown ? this.statsBreakdown(input, 's.toolId') : []
    }
  }

  getStatsGrowth(memoriesCount = 0): StatsGrowth {
    const activity = this.getStatsActivity({ range: 'all' })
    const sessions = (
      this.database.prepare('SELECT COUNT(*) AS value FROM sessions').get() as {
        value: number
      }
    ).value
    const favorite = this.database
      .prepare(
        `SELECT s.toolId AS toolId, COUNT(*) AS prompts
         FROM messages m JOIN sessions s ON s.id = m.sessionId
         WHERE m.role = 'user'
         GROUP BY s.toolId ORDER BY prompts DESC LIMIT 1`
      )
      .get() as { toolId: string } | undefined
    const peak = this.database
      .prepare(
        `SELECT CAST(strftime('%H', m.ts, 'localtime') AS INTEGER) AS hour,
          COUNT(*) AS prompts
         FROM messages m
         WHERE m.role = 'user' AND m.ts IS NOT NULL
         GROUP BY hour ORDER BY prompts DESC LIMIT 1`
      )
      .get() as { hour: number } | undefined
    const distinctTools = (
      this.database
        .prepare('SELECT COUNT(DISTINCT toolId) AS value FROM sessions')
        .get() as { value: number }
    ).value
    return calculateGrowth({
      activeDays: activity.activeDays,
      sessions,
      prompts: activity.totalPrompts,
      favoriteTool: favorite?.toolId ?? null,
      peakHour: peak?.hour ?? null,
      agentDiversity: distinctTools,
      memoriesCount,
      streakWeeks: Math.floor(activity.currentStreak / 7)
    })
  }

  private deleteSessionContent(id: string): void {
    const messageIds = this.database
      .prepare('SELECT id FROM messages WHERE sessionId = ?')
      .all(id) as Array<{ id: number }>
    const ids = messageIds.map((row) => row.id)
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      this.database.prepare(`DELETE FROM messages_hot_fts WHERE messageId IN (${placeholders})`).run(...ids)
      this.database.prepare(`DELETE FROM hot_indexed_messages WHERE messageId IN (${placeholders})`).run(...ids)
      this.database.prepare(`DELETE FROM message_index_meta WHERE messageId IN (${placeholders})`).run(...ids)
    }
    this.database.prepare('DELETE FROM usage_facts WHERE sessionId = ?').run(id)
    this.database.prepare('DELETE FROM messages WHERE sessionId = ?').run(id)
    this.database.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  private upsertUsageFacts(id: string, facts: TranscriptUsageFact[]): void {
    const insert = this.database.prepare(
      `INSERT INTO usage_facts (
        sessionId, factKey, model, ts, inputTokens, outputTokens,
        cacheWriteTokens, cacheReadTokens, estimatedCostUsd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sessionId, factKey) DO UPDATE SET
        model=excluded.model,
        ts=excluded.ts,
        inputTokens=excluded.inputTokens,
        outputTokens=excluded.outputTokens,
        cacheWriteTokens=excluded.cacheWriteTokens,
        cacheReadTokens=excluded.cacheReadTokens,
        estimatedCostUsd=excluded.estimatedCostUsd`
    )
    for (const fact of facts) {
      insert.run(
        id,
        fact.key,
        fact.model,
        fact.timestamp,
        fact.tokens.input,
        fact.tokens.output,
        fact.tokens.cacheWrite,
        fact.tokens.cacheRead,
        estimateUsageCost(fact)
      )
    }
  }

  private statsUsageTotals(input: StatsQuery): {
    tokens: StatsSummary['tokens']
    estimatedCostUsd: number
    unpricedFacts: number
    pricedFacts: number
  } {
    const filter = statsFilter(input)
    const usageFilter = [...filter.clauses]
    if (filter.from) usageFilter.push('u.ts >= ?')
    const usageParams = [...filter.params, ...(filter.from ? [filter.from] : [])]
    const usageWhere = usageFilter.length ? `WHERE ${usageFilter.join(' AND ')}` : ''
    const usage = this.database
      .prepare(
        `SELECT
          COALESCE(SUM(u.inputTokens), 0) AS input,
          COALESCE(SUM(u.outputTokens), 0) AS output,
          COALESCE(SUM(u.cacheWriteTokens), 0) AS cacheWrite,
          COALESCE(SUM(u.cacheReadTokens), 0) AS cacheRead,
          COALESCE(SUM(u.estimatedCostUsd), 0) AS estimatedCostUsd,
          COALESCE(SUM(CASE WHEN u.estimatedCostUsd IS NULL THEN 1 ELSE 0 END), 0)
            AS unpricedFacts,
          COALESCE(SUM(CASE WHEN u.estimatedCostUsd IS NOT NULL THEN 1 ELSE 0 END), 0)
            AS pricedFacts
         FROM usage_facts u JOIN sessions s ON s.id = u.sessionId
         ${usageWhere}`
      )
      .get(...usageParams) as {
      input: number
      output: number
      cacheWrite: number
      cacheRead: number
      estimatedCostUsd: number
      unpricedFacts: number
      pricedFacts: number
    }
    return {
      tokens: {
        input: usage.input,
        output: usage.output,
        cacheWrite: usage.cacheWrite,
        cacheRead: usage.cacheRead,
        total: usage.input + usage.output + usage.cacheWrite + usage.cacheRead
      },
      estimatedCostUsd: usage.estimatedCostUsd,
      unpricedFacts: usage.unpricedFacts,
      pricedFacts: usage.pricedFacts
    }
  }

  private statsBreakdown(input: StatsQuery, keyExpression: string): StatsBreakdownItem[] {
    const filter = statsFilter(input)
    const usageClauses = [...filter.clauses]
    if (filter.from) usageClauses.push('u.ts >= ?')
    const usageParams = [...filter.params, ...(filter.from ? [filter.from] : [])]
    const rows = this.database
      .prepare(
        `SELECT
          ${keyExpression} AS key,
          COUNT(DISTINCT s.id) AS sessions,
          0 AS prompts,
          COALESCE(SUM(
            u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens
          ), 0) AS tokens,
          COALESCE(SUM(u.estimatedCostUsd), 0) AS estimatedCostUsd,
          COALESCE(SUM(CASE WHEN u.estimatedCostUsd IS NULL THEN 1 ELSE 0 END), 0)
            AS unpricedFacts,
          COALESCE(SUM(CASE WHEN u.estimatedCostUsd IS NOT NULL THEN 1 ELSE 0 END), 0)
            AS pricedFacts
         FROM sessions s LEFT JOIN usage_facts u ON u.sessionId = s.id
         ${usageClauses.length ? `WHERE ${usageClauses.join(' AND ')}` : ''}
         GROUP BY ${keyExpression}
         ORDER BY tokens DESC`
      )
      .all(...usageParams) as AggregateRow[]

    const promptClauses = [...filter.clauses, `m.role = 'user'`]
    if (filter.from) promptClauses.push('m.ts >= ?')
    const promptRows = this.database
      .prepare(
        `SELECT ${keyExpression} AS key, COUNT(*) AS prompts
         FROM sessions s JOIN messages m ON m.sessionId = s.id
         WHERE ${promptClauses.join(' AND ')}
         GROUP BY ${keyExpression}`
      )
      .all(...filter.params, ...(filter.from ? [filter.from] : [])) as Array<{
      key: string
      prompts: number
    }>
    const prompts = new Map(promptRows.map((row) => [row.key, row.prompts]))
    return rows.map((row) => ({
      key: row.key,
      label: row.key === UNASSIGNED_STATS_PROJECT_KEY ? '未识别项目' : row.key,
      sessions: row.sessions,
      prompts: prompts.get(row.key) ?? 0,
      tokens: row.tokens,
      estimatedCostUsd: row.pricedFacts > 0 ? row.estimatedCostUsd : null,
      hasUnpricedUsage: row.unpricedFacts > 0
    }))
  }

  private statsModelBreakdown(input: StatsQuery): StatsSummary['byModel'] {
    const filter = statsFilter(input)
    const clauses = [...filter.clauses]
    if (filter.from) clauses.push('u.ts >= ?')
    const params = [...filter.params, ...(filter.from ? [filter.from] : [])]
    const rows = this.database
      .prepare(
        `SELECT
          COALESCE(NULLIF(u.model, ''), '未识别模型') AS model,
          COUNT(DISTINCT s.id) AS sessions,
          COUNT(*) AS facts,
          COALESCE(SUM(u.inputTokens), 0) AS input,
          COALESCE(SUM(u.outputTokens), 0) AS output,
          COALESCE(SUM(u.cacheWriteTokens), 0) AS cacheWrite,
          COALESCE(SUM(u.cacheReadTokens), 0) AS cacheRead,
          COALESCE(SUM(u.estimatedCostUsd), 0) AS estimatedCostUsd,
          COALESCE(SUM(CASE WHEN u.estimatedCostUsd IS NULL THEN 1 ELSE 0 END), 0)
            AS unpricedFacts,
          COALESCE(SUM(CASE WHEN u.estimatedCostUsd IS NOT NULL THEN 1 ELSE 0 END), 0)
            AS pricedFacts
         FROM usage_facts u JOIN sessions s ON s.id = u.sessionId
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         GROUP BY model
         ORDER BY (input + output + cacheWrite + cacheRead) DESC`
      )
      .all(...params) as Array<{
      model: string
      sessions: number
      facts: number
      input: number
      output: number
      cacheWrite: number
      cacheRead: number
      estimatedCostUsd: number
      unpricedFacts: number
      pricedFacts: number
    }>

    return rows.map((row) => ({
      key: row.model,
      label: row.model,
      sessions: row.sessions,
      facts: row.facts,
      tokens: {
        input: row.input,
        output: row.output,
        cacheWrite: row.cacheWrite,
        cacheRead: row.cacheRead,
        total: row.input + row.output + row.cacheWrite + row.cacheRead
      },
      estimatedCostUsd: row.pricedFacts > 0 ? row.estimatedCostUsd : null,
      hasUnpricedUsage: row.unpricedFacts > 0
    }))
  }

  private statsModelTrend(input: StatsQuery): StatsSummary['modelTrend'] {
    const filter = statsFilter(input)
    const clauses = [...filter.clauses, 'u.ts IS NOT NULL']
    if (filter.from) clauses.push('u.ts >= ?')
    const rows = this.database
      .prepare(
        `SELECT
          date(u.ts, 'localtime') AS date,
          COALESCE(NULLIF(u.model, ''), '未识别模型') AS model,
          COALESCE(SUM(u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens), 0)
            AS tokens
         FROM usage_facts u JOIN sessions s ON s.id = u.sessionId
         WHERE ${clauses.join(' AND ')}
         GROUP BY date, model
         ORDER BY date`
      )
      .all(...filter.params, ...(filter.from ? [filter.from] : [])) as Array<{
      date: string
      model: string
      tokens: number
    }>
    return rows
  }

  private statsTrend(input: StatsQuery): StatsTrendPoint[] {
    const filter = statsFilter(input)
    const clauses = [...filter.clauses, 'u.ts IS NOT NULL']
    if (filter.from) clauses.push('u.ts >= ?')
    const rows = this.database
      .prepare(
        `SELECT
          date(u.ts, 'localtime') AS date,
          0 AS prompts,
          SUM(u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens)
            AS tokens,
          SUM(u.estimatedCostUsd) AS estimatedCostUsd,
          SUM(CASE WHEN u.estimatedCostUsd IS NULL THEN 1 ELSE 0 END) AS unpricedFacts
         FROM usage_facts u JOIN sessions s ON s.id = u.sessionId
         WHERE ${clauses.join(' AND ')}
         GROUP BY date(u.ts, 'localtime') ORDER BY date`
      )
      .all(...filter.params, ...(filter.from ? [filter.from] : [])) as Array<
      StatsTrendPoint & { unpricedFacts: number }
    >
    return rows.map((row) => ({
      date: row.date,
      prompts: row.prompts,
      tokens: row.tokens,
      estimatedCostUsd: row.unpricedFacts > 0 ? null : row.estimatedCostUsd
    }))
  }

  private recordIndexedFile(path: string, byteOffset: number, mtime: number, size: number): void {
    this.database
      .prepare(
        `INSERT INTO indexed_files (path, byteOffset, mtime, size, status, error)
         VALUES (?, ?, ?, ?, 'indexed', NULL)
         ON CONFLICT(path) DO UPDATE SET
           byteOffset=excluded.byteOffset,
           mtime=excluded.mtime,
           size=excluded.size,
           status='indexed',
           error=NULL`
      )
      .run(path, byteOffset, mtime, size)
  }
}

function statsFilter(input: StatsQuery): {
  clauses: string[]
  params: unknown[]
  from: string | null
} {
  const clauses: string[] = []
  const params: unknown[] = []
  if (input.toolIds?.length) {
    clauses.push(`s.toolId IN (${input.toolIds.map(() => '?').join(',')})`)
    params.push(...input.toolIds)
  }
  if (input.workspacePath) {
    clauses.push('s.cwd = ?')
    params.push(input.workspacePath)
  } else if (input.unassignedWorkspace) {
    clauses.push(`(s.cwd IS NULL OR s.cwd = '')`)
  }
  const days =
    input.range === '7d' ? 7 : input.range === '30d' ? 30 : input.range === '90d' ? 90 : null
  const fromDate = days ? new Date() : null
  if (fromDate && days) {
    fromDate.setHours(0, 0, 0, 0)
    fromDate.setDate(fromDate.getDate() - (days - 1))
  }
  const from = fromDate?.toISOString() ?? null
  if (from) {
    clauses.push('s.lastActivityAt >= ?')
    params.push(from)
  }
  return { clauses, params, from }
}

function completeActivityDays(
  rows: Array<{ date: string; prompts: number }>,
  range: StatsQuery['range']
): Array<{ date: string; prompts: number }> {
  const counts = new Map(rows.map((row) => [row.date, row.prompts]))
  const count = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 365
  const end = new Date()
  end.setHours(12, 0, 0, 0)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end)
    date.setDate(end.getDate() - (count - index - 1))
    const key = localDateKey(date)
    return { date: key, prompts: counts.get(key) ?? 0 }
  })
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function calculateStreaks(activeDates: Set<string>): { current: number; longest: number } {
  const sorted = [...activeDates].sort()
  let longest = 0
  let run = 0
  let prior: Date | null = null
  for (const value of sorted) {
    const current = new Date(`${value}T12:00:00`)
    const gap = prior ? Math.round((current.getTime() - prior.getTime()) / 86_400_000) : 1
    run = gap === 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    prior = current
  }
  let current = 0
  const cursor = new Date()
  cursor.setHours(12, 0, 0, 0)
  if (!activeDates.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  while (activeDates.has(localDateKey(cursor))) {
    current += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return { current, longest }
}
