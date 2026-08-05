import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type {
  ManagedChatMessage,
  ManagedChatMessageStatus,
  ManagedChatPermissionStatus,
  ManagedQueuedTurn,
  ManagedChatTimelineItem,
  ManagedChatTimelineItemType,
  ReferencedMemory,
  TurnContextPack
} from '@shared/types'

const SCHEMA_VERSION = 5
const MAX_TEXT_LENGTH = 20_000

// trigram FTS 需 ≥3 字符；不足的词（含 1-2 个 CJK 字）退回 LIKE。
function splitTerms(query: string): { long: string[]; short: string[] } {
  const terms = query
    .trim()
    .split(/\s+/u)
    .map((t) => t.trim())
    .filter(Boolean)
  return {
    long: terms.filter((t) => Array.from(t).length >= 3),
    short: terms.filter((t) => Array.from(t).length < 3)
  }
}

function ftsExpr(terms: string[]): string {
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND ')
}

interface ChatMessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  text: string
  status: ManagedChatMessageStatus
  created_at: string
  updated_at: string
  referenced_memories: string | null
}

interface TimelineRow {
  id: string
  session_id: string
  turn_id: string
  seq: number
  type: ManagedChatTimelineItemType
  tool: string | null
  tool_use_id: string | null
  content: string | null
  input_json: string | null
  output: string | null
  is_error: number | null
  status: ManagedChatPermissionStatus | null
  created_at: string
}

interface QueuedTurnRow {
  id: string
  session_id: string
  text: string
  files_json: string
  context_pack: string | null
  status: 'queued'
  created_at: string
  updated_at: string
}

export interface ChatSessionMatch {
  sessionId: string
  /** 命中的消息原文（截断），空 query 列表时为 null。由上层裁剪/转义为 snippet。 */
  matchText: string | null
  messageCount: number
  lastActivityAt: string
}

function safeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length <= MAX_TEXT_LENGTH) return value
  return `${value.slice(0, MAX_TEXT_LENGTH)}\n... (truncated, ${value.length} chars)`
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null
  try {
    return safeText(JSON.stringify(value)) ?? null
  } catch {
    return safeText(String(value)) ?? null
  }
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function serializeReferencedMemories(value: ReferencedMemory[] | undefined): string | null {
  if (!value?.length) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function parseReferencedMemories(value: string | null): ReferencedMemory[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as ReferencedMemory[]) : []
  } catch {
    return []
  }
}

function parseStringArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseContextPack(value: string | null): TurnContextPack | undefined {
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== 'object') return undefined
  const item = parsed as Partial<TurnContextPack>
  if (item.version !== 1 || typeof item.text !== 'string' || !Array.isArray(item.referencedMemories)) {
    return undefined
  }
  return {
    version: 1,
    text: item.text,
    referencedMemories: item.referencedMemories as TurnContextPack['referencedMemories'],
    generatedAt: typeof item.generatedAt === 'string' ? item.generatedAt : new Date(0).toISOString(),
    estimatedTokens: typeof item.estimatedTokens === 'number' ? item.estimatedTokens : 0
  }
}

function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  try {
    return new Database(path)
  } catch {
    if (existsSync(path)) {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
    }
    return new Database(path)
  }
}

export class ChatSqliteStore {
  private readonly database: Database.Database

  constructor(path: string) {
    this.database = openDatabase(path)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('foreign_keys = ON')
    this.database.pragma('cache_size = -64000') // 64MB 页缓存，配合 FTS 提升搜索吞吐
    this.migrate()
  }

  close(): void {
    this.database.close()
  }

  listMessages(sessionId: string): ManagedChatMessage[] {
    return this.database
      .prepare(
        `SELECT id, session_id, role, text, status, created_at, updated_at, referenced_memories
         FROM chat_messages
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(sessionId)
      .map((row) => this.mapMessage(row as ChatMessageRow))
  }

  /**
   * 跨会话正文检索（统一会话搜索的自建 agent 对话来源）。
   * query 为空时返回各会话最近活动（用于默认列表）；非空时走 chat_messages_fts(trigram) MATCH，
   * <3 字符/短 CJK 词退回 LIKE；每个会话取最近一条命中消息为 snippet 源。
   */
  searchSessions(query: string, limit: number): ChatSessionMatch[] {
    const cap = Math.max(1, Math.min(limit, 200))
    const trimmed = query.trim()
    if (!trimmed) {
      return this.database
        .prepare(
          `SELECT session_id AS sessionId,
                  COUNT(*) AS messageCount,
                  MAX(updated_at) AS lastActivityAt
           FROM chat_messages
           GROUP BY session_id
           ORDER BY lastActivityAt DESC
           LIMIT ?`
        )
        .all(cap)
        .map((row) => {
          const r = row as { sessionId: string; messageCount: number; lastActivityAt: string }
          return { sessionId: r.sessionId, matchText: null, messageCount: r.messageCount, lastActivityAt: r.lastActivityAt }
        })
    }

    const { long, short } = splitTerms(trimmed)
    const scan = Math.max(cap * 8, 80)
    let rows: Array<{ sessionId: string; text: string; updatedAt: string }>
    if (long.length > 0) {
      // 走 FTS：MATCH 命中后 JOIN 回正表，按最近活动取近期命中（短词在 JS 端再过滤）。
      rows = this.database
        .prepare(
          `SELECT m.session_id AS sessionId, m.text AS text, m.updated_at AS updatedAt
           FROM chat_messages_fts f
           JOIN chat_messages m ON m.rowid = f.rowid
           WHERE chat_messages_fts MATCH ?
           ORDER BY m.updated_at DESC
           LIMIT ?`
        )
        .all(ftsExpr(long), scan) as Array<{ sessionId: string; text: string; updatedAt: string }>
      if (short.length > 0) {
        const lowers = short.map((t) => t.toLowerCase())
        rows = rows.filter((r) => lowers.every((t) => r.text.toLowerCase().includes(t)))
      }
    } else {
      // 仅 <3 字符 / 短 CJK 词：FTS 无法命中，退回 LIKE（受 LIMIT 约束，有界）。
      const where = short.map(() => 'LOWER(text) LIKE LOWER(?)').join(' AND ')
      rows = this.database
        .prepare(
          `SELECT session_id AS sessionId, text, updated_at AS updatedAt
           FROM chat_messages
           WHERE ${where}
           ORDER BY updated_at DESC
           LIMIT ?`
        )
        .all(...short.map((t) => `%${t}%`), scan) as Array<{ sessionId: string; text: string; updatedAt: string }>
    }

    const bySession = new Map<string, string>()
    for (const row of rows) {
      if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, row.text)
      if (bySession.size >= cap) break
    }
    if (bySession.size === 0) return []

    const ids = [...bySession.keys()]
    const placeholders = ids.map(() => '?').join(',')
    const stats = this.database
      .prepare(
        `SELECT session_id AS sessionId,
                COUNT(*) AS messageCount,
                MAX(updated_at) AS lastActivityAt
         FROM chat_messages
         WHERE session_id IN (${placeholders})
         GROUP BY session_id`
      )
      .all(...ids) as Array<{ sessionId: string; messageCount: number; lastActivityAt: string }>
    const statById = new Map(stats.map((s) => [s.sessionId, s]))

    return ids.map((sessionId) => {
      const stat = statById.get(sessionId)
      return {
        sessionId,
        matchText: bySession.get(sessionId) ?? null,
        messageCount: stat?.messageCount ?? 0,
        lastActivityAt: stat?.lastActivityAt ?? new Date(0).toISOString()
      }
    })
  }

  appendMessage(
    sessionId: string,
    message: Omit<ManagedChatMessage, 'id' | 'createdAt' | 'updatedAt'>
  ): ManagedChatMessage {
    const now = new Date().toISOString()
    const created: ManagedChatMessage = {
      ...message,
      id: randomUUID(),
      text: safeText(message.text) ?? '',
      createdAt: now,
      updatedAt: now
    }
    this.touchSession(sessionId, now)
    this.database
      .prepare(
        `INSERT INTO chat_messages (id, session_id, role, text, status, created_at, updated_at, referenced_memories)
         VALUES (@id, @sessionId, @role, @text, @status, @createdAt, @updatedAt, @referencedMemories)`
      )
      .run({
        ...created,
        sessionId,
        referencedMemories: serializeReferencedMemories(created.referencedMemories)
      })
    return created
  }

  updateMessage(
    sessionId: string,
    messageId: string,
    patch: { text?: string; status?: ManagedChatMessageStatus; referencedMemories?: ReferencedMemory[] }
  ): ManagedChatMessage | null {
    const current = this.database
      .prepare(
        `SELECT id, session_id, role, text, status, created_at, updated_at, referenced_memories
         FROM chat_messages
         WHERE session_id = ? AND id = ?`
      )
      .get(sessionId, messageId) as ChatMessageRow | undefined
    if (!current) return null
    const updated: ManagedChatMessage = {
      ...this.mapMessage(current),
      ...(patch.text !== undefined ? { text: safeText(patch.text) ?? '' } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.referencedMemories !== undefined ? { referencedMemories: patch.referencedMemories } : {}),
      updatedAt: new Date().toISOString()
    }
    this.touchSession(sessionId, updated.updatedAt)
    this.database
      .prepare(
        `UPDATE chat_messages
         SET text = @text, status = @status, updated_at = @updatedAt, referenced_memories = @referencedMemories
         WHERE session_id = @sessionId AND id = @id`
      )
      .run({
        ...updated,
        sessionId,
        referencedMemories: serializeReferencedMemories(updated.referencedMemories)
      })
    return updated
  }

  markInterruptedMessages(): void {
    const now = new Date().toISOString()
    this.database
      .prepare(
        `UPDATE chat_messages
         SET status = 'interrupted', updated_at = ?
         WHERE status = 'streaming'`
      )
      .run(now)
  }

  listTimeline(sessionId: string): ManagedChatTimelineItem[] {
    return this.database
      .prepare(
        `SELECT id, session_id, turn_id, seq, type, tool, tool_use_id, content,
                input_json, output, is_error, status, created_at
         FROM chat_timeline_items
         WHERE session_id = ?
         ORDER BY seq ASC, created_at ASC, id ASC`
      )
      .all(sessionId)
      .map((row) => this.mapTimeline(row as TimelineRow))
  }

  appendTimelineItem(
    item: Omit<ManagedChatTimelineItem, 'id' | 'createdAt'>
  ): ManagedChatTimelineItem {
    const created: ManagedChatTimelineItem = {
      ...item,
      id: randomUUID(),
      content: safeText(item.content),
      output: safeText(item.output),
      createdAt: new Date().toISOString()
    }
    this.touchSession(created.sessionId, created.createdAt)
    this.database
      .prepare(
        `INSERT INTO chat_timeline_items (
           id, session_id, turn_id, seq, type, tool, tool_use_id, content,
           input_json, output, is_error, status, created_at
         )
         VALUES (
           @id, @sessionId, @turnId, @seq, @type, @tool, @toolUseId, @content,
           @inputJson, @output, @isError, @status, @createdAt
         )`
      )
      .run({
        ...created,
        tool: created.tool ?? null,
        toolUseId: created.toolUseId ?? null,
        content: created.content ?? null,
        inputJson: safeJson(created.input),
        output: created.output ?? null,
        isError: created.isError === undefined ? null : created.isError ? 1 : 0,
        status: created.status ?? null
      })
    return created
  }

  updatePermissionStatus(
    sessionId: string,
    turnId: string,
    toolUseId: string,
    status: ManagedChatPermissionStatus
  ): ManagedChatTimelineItem | null {
    const row = this.database
      .prepare(
        `SELECT id, session_id, turn_id, seq, type, tool, tool_use_id, content,
                input_json, output, is_error, status, created_at
         FROM chat_timeline_items
         WHERE session_id = ? AND turn_id = ? AND tool_use_id = ? AND type = 'permission'
         ORDER BY seq DESC
         LIMIT 1`
      )
      .get(sessionId, turnId, toolUseId) as TimelineRow | undefined
    if (!row) return null
    this.database
      .prepare(`UPDATE chat_timeline_items SET status = ? WHERE id = ?`)
      .run(status, row.id)
    return this.mapTimeline({ ...row, status })
  }

  enqueueTurn(
    sessionId: string,
    input: { text: string; files?: string[]; contextPack?: TurnContextPack }
  ): ManagedQueuedTurn {
    const now = new Date().toISOString()
    const created: ManagedQueuedTurn = {
      id: randomUUID(),
      sessionId,
      text: safeText(input.text) ?? '',
      files: input.files ?? [],
      ...(input.contextPack ? { contextPack: input.contextPack } : {}),
      status: 'queued',
      createdAt: now,
      updatedAt: now
    }
    this.touchSession(sessionId, now)
    this.database
      .prepare(
        `INSERT INTO chat_queued_turns (id, session_id, text, files_json, context_pack, status, created_at, updated_at)
         VALUES (@id, @sessionId, @text, @filesJson, @contextPack, @status, @createdAt, @updatedAt)`
      )
      .run({
        ...created,
        filesJson: JSON.stringify(created.files),
        contextPack: safeJson(created.contextPack)
      })
    return created
  }

  listQueuedTurns(sessionId: string): ManagedQueuedTurn[] {
    return this.database
      .prepare(
        `SELECT id, session_id, text, files_json, context_pack, status, created_at, updated_at
         FROM chat_queued_turns
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(sessionId)
      .map((row) => this.mapQueuedTurn(row as QueuedTurnRow))
  }

  cancelQueuedTurn(sessionId: string, queuedTurnId: string): boolean {
    const result = this.database
      .prepare(`DELETE FROM chat_queued_turns WHERE session_id = ? AND id = ?`)
      .run(sessionId, queuedTurnId)
    return result.changes > 0
  }

  nextSeq(sessionId: string): number {
    const row = this.database
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM chat_timeline_items WHERE session_id = ?`)
      .get(sessionId) as { next: number }
    return row.next
  }

  private touchSession(id: string, now = new Date().toISOString()): void {
    this.database
      .prepare(
        `INSERT INTO chat_sessions (id, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(id, now, now)
  }

  private mapMessage(row: ChatMessageRow): ManagedChatMessage {
    const referenced = parseReferencedMemories(row.referenced_memories)
    return {
      id: row.id,
      role: row.role,
      text: row.text,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(referenced.length ? { referencedMemories: referenced } : {})
    }
  }

  private mapTimeline(row: TimelineRow): ManagedChatTimelineItem {
    return {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      seq: row.seq,
      type: row.type,
      ...(row.tool ? { tool: row.tool } : {}),
      ...(row.tool_use_id ? { toolUseId: row.tool_use_id } : {}),
      ...(row.content ? { content: row.content } : {}),
      ...(row.input_json ? { input: parseJson(row.input_json) } : {}),
      ...(row.output ? { output: row.output } : {}),
      ...(row.is_error === null ? {} : { isError: Boolean(row.is_error) }),
      ...(row.status ? { status: row.status } : {}),
      createdAt: row.created_at
    }
  }

  private mapQueuedTurn(row: QueuedTurnRow): ManagedQueuedTurn {
    return {
      id: row.id,
      sessionId: row.session_id,
      text: row.text,
      files: parseStringArray(row.files_json),
      ...(parseContextPack(row.context_pack) ? { contextPack: parseContextPack(row.context_pack) } : {}),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private migrate(): void {
    const previous = this.database.pragma('user_version', { simple: true }) as number
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('streaming', 'completed', 'interrupted', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        referenced_memories TEXT,
        FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
        ON chat_messages(session_id, created_at, id);

      CREATE TABLE IF NOT EXISTS chat_timeline_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('text', 'thinking', 'tool_use', 'tool_result', 'error', 'permission')),
        tool TEXT,
        tool_use_id TEXT,
        content TEXT,
        input_json TEXT,
        output TEXT,
        is_error INTEGER,
        status TEXT CHECK(status IN ('pending', 'allowed-once', 'allowed-always', 'denied')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_timeline_session_seq
        ON chat_timeline_items(session_id, seq);

      CREATE INDEX IF NOT EXISTS idx_chat_timeline_session_turn
        ON chat_timeline_items(session_id, turn_id, seq);

      CREATE TABLE IF NOT EXISTS chat_queued_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        files_json TEXT NOT NULL DEFAULT '[]',
        context_pack TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chat_queued_turns_session_created
        ON chat_queued_turns(session_id, created_at, id);

      -- 正文全文检索（trigram，CJK 友好）。rowid 对齐 chat_messages.rowid 便于同步与清理。
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
        text,
        messageId UNINDEXED,
        sessionId UNINDEXED,
        role UNINDEXED,
        tokenize='trigram'
      );

      -- 触发器保证 FTS 与 chat_messages 一致：直接增删改 + 会话级联删除兜底。
      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(rowid, text, messageId, sessionId, role)
        VALUES (new.rowid, new.text, new.id, new.session_id, new.role);
      END;
      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au AFTER UPDATE OF text ON chat_messages BEGIN
        DELETE FROM chat_messages_fts WHERE rowid = old.rowid;
        INSERT INTO chat_messages_fts(rowid, text, messageId, sessionId, role)
        VALUES (new.rowid, new.text, new.id, new.session_id, new.role);
      END;
      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
        DELETE FROM chat_messages_fts WHERE rowid = old.rowid;
      END;
      -- 删除会话时 chat_messages 走 FK CASCADE（默认不触发子表 AFTER DELETE），按 sessionId 兜底清理 FTS。
      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_session_ad AFTER DELETE ON chat_sessions BEGIN
        DELETE FROM chat_messages_fts WHERE sessionId = old.id;
      END;
    `)

    if (previous < 2) this.backfillFts()
    // v3：存量库补 referenced_memories 列（IF NOT EXISTS 不会改已存在表，故显式 ALTER）。
    if (previous < 3) {
      try {
        this.database.exec('ALTER TABLE chat_messages ADD COLUMN referenced_memories TEXT')
      } catch {
        // 列已存在（全新库或重复迁移）：忽略。
      }
    }
    if (previous < 5) {
      try {
        this.database.exec('ALTER TABLE chat_queued_turns ADD COLUMN context_pack TEXT')
      } catch {
        // 新库已经在 CREATE TABLE 中具备该列，或重复迁移时列已存在。
      }
    }
    this.database.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  /** 一次性把存量 chat_messages 灌入 FTS（幂等可续：按 rowid 缺失补齐，分批避免长事务）。 */
  private backfillFts(batch = 2000): void {
    const insert = this.database.prepare(
      `INSERT INTO chat_messages_fts(rowid, text, messageId, sessionId, role)
       SELECT m.rowid, m.text, m.id, m.session_id, m.role
       FROM chat_messages m
       WHERE m.rowid NOT IN (SELECT rowid FROM chat_messages_fts)
       LIMIT ?`
    )
    let inserted = 0
    do {
      inserted = insert.run(batch).changes
    } while (inserted > 0)
    this.database.exec(`INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('optimize')`)
  }
}
