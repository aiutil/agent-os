import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { getCurrentLang, tr } from '@shared/i18n'
import {
  defaultCurationPrompt,
  DEFAULT_KNOWLEDGE_CURATION_PROMPT,
  DEFAULT_MEMORY_CURATION_PROMPT,
  isBundledCurationPrompt,
  type CurationPromptKind
} from '@shared/curation-prompts'
import type {
  CurationWatermark,
  DurableMemory,
  ExperienceEntry,
  GraphSnapshot,
  ListDurableMemoriesInput,
  MemoryClass,
  MemoryContextInput,
  MemoryContextPack,
  MemoryEvidence,
  MemoryFeedbackInput,
  MemoryGatewayCapability,
  MemoryGraphInput,
  MemoryScope,
  MemorySettings,
  MemoryStatus,
  ProposeMemoryInput,
  UpdateWorkingMemoryInput,
  UpdateDurableMemoryPatch
  ,WorkingMemoryState
} from '@shared/types'

const DEFAULT_SETTINGS: MemorySettings = {
  enabled: true,
  useMemories: true,
  generateMemories: true,
  knowledgeCurationEnabled: true,
  allowExternalContext: false,
  contextTokenBudget: 800,
  memoryCurationPromptMode: 'default',
  memoryCurationPrompt: DEFAULT_MEMORY_CURATION_PROMPT,
  knowledgeCurationPromptMode: 'default',
  knowledgeCurationPrompt: DEFAULT_KNOWLEDGE_CURATION_PROMPT
}

function promptMode(
  kind: CurationPromptKind,
  configured: 'default' | 'custom' | undefined,
  value: string | undefined
): 'default' | 'custom' {
  if (configured === 'default' || configured === 'custom') return configured
  return !value?.trim() || isBundledCurationPrompt(kind, value) ? 'default' : 'custom'
}

function resolvedPrompt(
  kind: CurationPromptKind,
  mode: 'default' | 'custom',
  value: string | undefined
): string {
  if (mode === 'default') return defaultCurationPrompt(kind, getCurrentLang())
  return value?.trim() || defaultCurationPrompt(kind, getCurrentLang())
}

const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[a-z0-9_-]{16,}/iu,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
  /(?:sk|rk|ghp|github_pat)_[a-z0-9_-]{16,}/iu
]

interface MemoryRow {
  id: string
  kind: DurableMemory['kind']
  title: string
  content: string
  scope: DurableMemory['scope']
  scopeRef: string | null
  status: MemoryStatus
  confidence: DurableMemory['confidence']
  sensitivity: DurableMemory['sensitivity']
  tags: string
  pinned: number
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  rejectionReason: string | null
  memoryClass: MemoryClass | null
  lifetime: 'durable' | null
  legacy: number | null
  lastAccessedAt: string | null
  accessCount: number | null
  validFrom: string | null
  validUntil: string | null
}

interface WorkingMemoryRow {
  sessionId: string
  goal: string | null
  constraints: string
  decisions: string
  openQuestions: string
  artifacts: string
  updatedAt: string
  expiresAt: string
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim())
          .filter(Boolean)
      : []
  } catch {
    return []
  }
}

function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))]
}

function classForKind(kind: DurableMemory['kind']): MemoryClass {
  if (kind === 'preference') return 'identity'
  if (kind === 'convention' || kind === 'procedure' || kind === 'pitfall') return 'procedural'
  return 'semantic'
}

function parseStringList(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : []
  } catch {
    return []
  }
}

function containsSensitiveContent(value: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))
}

function estimateTokens(value: string): number {
  // 中英文混排的保守近似；token budget 仅用于上下文裁剪，非计费口径。
  return Math.max(1, Math.ceil(value.length / 3))
}

function safePathStartsWith(candidate: string, parent: string): boolean {
  const absoluteCandidate = resolve(candidate)
  const absoluteParent = resolve(parent)
  return (
    absoluteCandidate === absoluteParent || absoluteCandidate.startsWith(`${absoluteParent}${sep}`)
  )
}

function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localDayWindow(date: Date): { start: string; end: string } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

/**
 * 本地长期记忆真源。它不索引 CLI 历史，也不写入任何第三方私有格式；历史只以 evidence
 * 引用的方式与长期记忆关联。
 */
export class MemoryVault {
  private readonly database: Database.Database
  private readonly exportPath: string

  constructor(
    readonly path: string,
    private readonly clock: () => Date = () => new Date()
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      chmodSync(dirname(path), 0o700)
    } catch {
      // Windows 和受限文件系统可能不支持 POSIX mode；SQLite 仍可正常工作。
    }
    this.database = new Database(path)
    this.database.pragma('journal_mode = WAL')
    this.initialize()
    this.migrateV2Schema()
    this.ensureSettingsSeed()
    this.exportPath = join(dirname(path), 'exports', 'active-memories.md')
    this.exportSnapshot()
  }

  close(): void {
    this.database.close()
  }

  getSettings(): MemorySettings {
    const row = this.database
      .prepare('SELECT value FROM memory_policies WHERE key = ?')
      .get('settings') as { value: string } | undefined
    if (!row) {
      return {
        ...DEFAULT_SETTINGS,
        memoryCurationPrompt: defaultCurationPrompt('memory', getCurrentLang()),
        knowledgeCurationPrompt: defaultCurationPrompt('knowledge', getCurrentLang())
      }
    }
    try {
      const value = JSON.parse(row.value) as Partial<MemorySettings>
      const memoryValue = value.memoryCurationPrompt || value.curationInstructions
      const memoryCurationPromptMode = promptMode(
        'memory',
        value.memoryCurationPromptMode,
        memoryValue
      )
      const knowledgeCurationPromptMode = promptMode(
        'knowledge',
        value.knowledgeCurationPromptMode,
        value.knowledgeCurationPrompt
      )
      return {
        ...DEFAULT_SETTINGS,
        ...value,
        memoryCurationPromptMode,
        memoryCurationPrompt: resolvedPrompt('memory', memoryCurationPromptMode, memoryValue),
        knowledgeCurationPromptMode,
        knowledgeCurationPrompt: resolvedPrompt(
          'knowledge',
          knowledgeCurationPromptMode,
          value.knowledgeCurationPrompt
        ),
        contextTokenBudget: clampBudget(
          value.contextTokenBudget ?? DEFAULT_SETTINGS.contextTokenBudget
        )
      }
    } catch {
      return {
        ...DEFAULT_SETTINGS,
        memoryCurationPrompt: defaultCurationPrompt('memory', getCurrentLang()),
        knowledgeCurationPrompt: defaultCurationPrompt('knowledge', getCurrentLang())
      }
    }
  }

  updateSettings(patch: Partial<MemorySettings>): MemorySettings {
    const current = this.getSettings()
    const memoryCurationPromptMode =
      patch.memoryCurationPromptMode ??
      (patch.memoryCurationPrompt !== undefined
        ? promptMode('memory', undefined, patch.memoryCurationPrompt)
        : current.memoryCurationPromptMode ?? 'default')
    const knowledgeCurationPromptMode =
      patch.knowledgeCurationPromptMode ??
      (patch.knowledgeCurationPrompt !== undefined
        ? promptMode('knowledge', undefined, patch.knowledgeCurationPrompt)
        : current.knowledgeCurationPromptMode ?? 'default')
    const next: MemorySettings = {
      ...current,
      ...patch,
      memoryCurationPromptMode,
      memoryCurationPrompt: resolvedPrompt(
        'memory',
        memoryCurationPromptMode,
        patch.memoryCurationPrompt ?? current.memoryCurationPrompt
      ),
      knowledgeCurationPromptMode,
      knowledgeCurationPrompt: resolvedPrompt(
        'knowledge',
        knowledgeCurationPromptMode,
        patch.knowledgeCurationPrompt ?? current.knowledgeCurationPrompt
      ),
      contextTokenBudget: clampBudget(patch.contextTokenBudget ?? current.contextTokenBudget)
    }
    // 自动提炼首次开启时打纪元；之后即便关闭再开也沿用旧纪元，避免回溯churn 历史。
    if (next.generateMemories && !next.curationEpoch) next.curationEpoch = this.now()
    this.writeSettings(next)
    return next
  }

  private writeSettings(value: MemorySettings): void {
    this.database
      .prepare(
        `INSERT INTO memory_policies (key, value, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`
      )
      .run('settings', JSON.stringify(value), this.now())
  }

  /** 首启时把默认设置（含自动提炼纪元）落库，使默认开启的自动提炼立即生效。 */
  private ensureSettingsSeed(): void {
    const row = this.database
      .prepare('SELECT value FROM memory_policies WHERE key = ?')
      .get('settings') as { value: string } | undefined
    if (row) {
      // 旧库已有设置但缺纪元且自动提炼开着：补打纪元（以当下为准，不回溯历史）。
      const settings = this.getSettings()
      if (settings.generateMemories && !settings.curationEpoch) {
        this.writeSettings({ ...settings, curationEpoch: this.now() })
      }
      return
    }
    this.writeSettings({ ...DEFAULT_SETTINGS, curationEpoch: this.now() })
  }

  /** 读取单会话提炼水位线（去重/增量判断用）。 */
  getCurationWatermark(sourceId: string): CurationWatermark | null {
    const row = this.database
      .prepare(
        'SELECT sourceId, messageCount, lastCuratedAt FROM curation_watermarks WHERE sourceId = ?'
      )
      .get(sourceId) as
      | { sourceId: string; messageCount: number | null; lastCuratedAt: string }
      | undefined
    return row ?? null
  }

  /** 记录一次成功提炼的水位线（沉淀链路统一在此打点，跨链路共享去重）。 */
  recordCuration(sourceId: string, messageCount: number | null): void {
    this.database
      .prepare(
        `INSERT INTO curation_watermarks (sourceId, messageCount, lastCuratedAt) VALUES (?, ?, ?)
         ON CONFLICT(sourceId) DO UPDATE SET
           messageCount=MAX(COALESCE(curation_watermarks.messageCount, 0), COALESCE(excluded.messageCount, 0)),
           lastCuratedAt=excluded.lastCuratedAt`
      )
      .run(sourceId, messageCount, this.now())
  }

  /**
   * 全局「用户画像」（人格）：单份、手动维护的高维协作偏好。存在 memory_policies 的
   * 'persona' key。由 context() 在记忆块之前注入，作为最高优先级 preamble。
   */
  getPersona(): string {
    const row = this.database
      .prepare('SELECT value FROM memory_policies WHERE key = ?')
      .get('persona') as { value: string } | undefined
    return row?.value ?? ''
  }

  setPersona(text: string): string {
    const value = text.trim()
    this.database
      .prepare(
        `INSERT INTO memory_policies (key, value, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`
      )
      .run('persona', value, this.now())
    return value
  }

  getWorking(sessionId: string): WorkingMemoryState | null {
    this.expireWorking()
    const row = this.database
      .prepare('SELECT * FROM working_memories WHERE sessionId = ?')
      .get(sessionId) as WorkingMemoryRow | undefined
    return row ? this.hydrateWorking(row) : null
  }

  updateWorking(input: UpdateWorkingMemoryInput): WorkingMemoryState {
    const current = this.getWorking(input.sessionId)
    const now = this.now()
    const expiresAt = new Date(this.clock().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const next: WorkingMemoryState = {
      sessionId: input.sessionId,
      ...(input.goal === null ? {} : input.goal?.trim() ? { goal: input.goal.trim() } : current?.goal ? { goal: current.goal } : {}),
      constraints: cleanWorkingItems(input.constraints ?? current?.constraints ?? []),
      decisions: cleanWorkingItems(input.decisions ?? current?.decisions ?? []),
      openQuestions: cleanWorkingItems(input.openQuestions ?? current?.openQuestions ?? []),
      artifacts: cleanWorkingItems(input.artifacts ?? current?.artifacts ?? []),
      updatedAt: now,
      expiresAt
    }
    this.database
      .prepare(
        `INSERT INTO working_memories (sessionId, goal, constraints, decisions, openQuestions, artifacts, updatedAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sessionId) DO UPDATE SET goal=excluded.goal, constraints=excluded.constraints,
           decisions=excluded.decisions, openQuestions=excluded.openQuestions, artifacts=excluded.artifacts,
           updatedAt=excluded.updatedAt, expiresAt=excluded.expiresAt`
      )
      .run(
        next.sessionId,
        next.goal ?? null,
        JSON.stringify(next.constraints),
        JSON.stringify(next.decisions),
        JSON.stringify(next.openQuestions),
        JSON.stringify(next.artifacts),
        next.updatedAt,
        next.expiresAt
      )
    return next
  }

  clearWorking(sessionId: string): void {
    this.database.prepare('DELETE FROM working_memories WHERE sessionId = ?').run(sessionId)
  }

  portableState(): {
    persona: string
    settings: MemorySettings
    items: DurableMemory[]
  } {
    this.archiveExpiredCandidates()
    const rows = this.database
      .prepare('SELECT * FROM memories ORDER BY pinned DESC, updatedAt DESC')
      .all() as MemoryRow[]
    return {
      persona: this.getPersona(),
      settings: this.getSettings(),
      items: rows.map((row) => this.hydrate(row))
    }
  }

  /**
   * 仅供经过 schema 校验的本地迁移服务调用。整批替换在单个 SQLite 事务内完成；
   * feedback/每日配额保留，避免导入动作重置成长与安全预算。
   */
  replacePortableState(input: {
    persona: string
    settings: MemorySettings
    items: DurableMemory[]
  }): void {
    const write = this.database.transaction(() => {
      this.database.prepare('DELETE FROM memory_evidence').run()
      this.database.prepare('DELETE FROM memories_fts').run()
      this.database.prepare('DELETE FROM memories').run()
      for (const memory of input.items) {
        this.insert(memory)
        this.replaceEvidence(memory.id, memory.evidence)
      }
      this.setPersona(input.persona)
      this.writeSettings(input.settings)
    })
    write.immediate()
    this.exportSnapshot()
  }

  list(input: ListDurableMemoriesInput = {}): DurableMemory[] {
    this.archiveExpiredCandidates()
    const statuses = input.statuses?.length ? input.statuses : undefined
    const filters: string[] = []
    const params: unknown[] = []
    if (statuses) {
      filters.push(`m.status IN (${statuses.map(() => '?').join(',')})`)
      params.push(...statuses)
    }
    if (input.scopes?.length) {
      filters.push(`m.scope IN (${input.scopes.map(() => '?').join(',')})`)
      params.push(...input.scopes)
    }
    if (input.tags?.length) {
      // tags 列存 JSON 数组；命中任一指定 tag 即可（按渠道筛选"飞书记忆"等）。
      const conds = input.tags.map(() => 'm.tags LIKE ?')
      filters.push(`(${conds.join(' OR ')})`)
      params.push(...input.tags.map((tag) => `%"${tag.replaceAll('"', '""')}%"`))
    }
    if (input.query?.trim()) {
      const terms = input.query.trim().split(/\s+/u).filter(Boolean)
      if (terms.length > 0 && terms.every((term) => Array.from(term).length >= 3)) {
        filters.push('m.id IN (SELECT memoryId FROM memories_fts WHERE memories_fts MATCH ?)')
        params.push(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND '))
      } else {
        const like = `%${input.query.trim()}%`
        filters.push(
          '(LOWER(m.title) LIKE LOWER(?) OR LOWER(m.content) LIKE LOWER(?) OR LOWER(m.tags) LIKE LOWER(?))'
        )
        params.push(like, like, like)
      }
    }
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1_501))
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const rows = this.database
      .prepare(
        `SELECT m.* FROM memories m ${where}
         ORDER BY m.pinned DESC, m.updatedAt DESC LIMIT ?`
      )
      .all(...params, limit) as MemoryRow[]
    return rows.map((row) => this.hydrate(row))
  }

  get(id: string): DurableMemory | null {
    const row = this.database.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | MemoryRow
      | undefined
    return row ? this.hydrate(row) : null
  }

  /**
   * 所有来源、类型和作用域共享本地自然日预算。此方法只用于调用方提前跳过昂贵的
   * curator；真正的并发安全约束在 insertWithDailyLimit() 的 SQLite 写事务中。
   */
  canDepositToday(): boolean {
    const date = this.clock()
    const key = localDateKey(date)
    const { start, end } = localDayWindow(date)
    let available = true
    const check = this.database.transaction(() => {
      const occupied = this.database
        .prepare('SELECT memoryId FROM memory_daily_deposits WHERE localDate = ?')
        .get(key)
      if (occupied) {
        available = false
        return
      }
      const existing = this.database
        .prepare(
          'SELECT id FROM memories WHERE createdAt >= ? AND createdAt < ? ORDER BY createdAt ASC LIMIT 1'
        )
        .get(start, end) as { id: string } | undefined
      if (!existing) return
      // 升级后的首次检查即回填占用，确保随后删除旧记录也不会释放当天预算。
      this.database
        .prepare(
          'INSERT INTO memory_daily_deposits (localDate, memoryId, createdAt) VALUES (?, ?, ?)'
        )
        .run(key, existing.id, this.now())
      available = false
    })
    check.immediate()
    return available
  }

  propose(input: ProposeMemoryInput): DurableMemory {
    const title = input.title.trim()
    const content = input.content.trim()
    if (!title || !content) throw new Error(tr('memory.vault.error.titleContentEmpty'))
    if (containsSensitiveContent(`${title}\n${content}`)) {
      throw new Error(tr('memory.vault.error.sensitive'))
    }
    const currentDate = this.clock()
    const createdAt = currentDate.toISOString()
    const memory: DurableMemory = {
      id: randomUUID(),
      kind: input.kind,
      title,
      content,
      scope: input.scope,
      ...(input.scopeRef?.trim() ? { scopeRef: input.scopeRef.trim() } : {}),
      status: 'candidate',
      confidence: input.confidence ?? 'inferred',
      sensitivity: input.sensitivity ?? 'normal',
      tags: cleanTags(input.tags),
      evidence: input.evidence ?? [],
      pinned: false,
      memoryClass: classForKind(input.kind),
      lifetime: 'durable',
      legacy: false,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(currentDate.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }
    this.insertWithDailyLimit(memory, currentDate)
    this.exportSnapshot()
    return memory
  }

  /**
   * 直接以 active 落库（curator 自动整理路径）：免审批、立刻可被 agent 读取。
   * 与 propose 的区别：status='active'、confidence='confirmed'、无 expiresAt。
   * 去重：同 title+scope+scopeRef 的 active 记忆已存在则合并更新（刷新内容、合并 tags），
   * 避免空闲调度反复提炼造成刷屏。
   */
  addActive(input: ProposeMemoryInput): DurableMemory {
    const title = input.title.trim()
    const content = input.content.trim()
    if (!title || !content) throw new Error(tr('memory.vault.error.titleContentEmpty'))
    if (containsSensitiveContent(`${title}\n${content}`)) {
      throw new Error(tr('memory.vault.error.sensitive'))
    }
    const scopeRef = input.scopeRef?.trim() || undefined
    const existing = this.findActiveByFingerprint(title, input.scope, scopeRef)
    if (existing) {
      const mergedTags = cleanTags([...existing.tags, ...(input.tags ?? [])])
      const updated = this.update(existing.id, {
        content,
        kind: input.kind,
        tags: mergedTags
      })
      if (updated) return updated
    }
    const currentDate = this.clock()
    const createdAt = currentDate.toISOString()
    const memory: DurableMemory = {
      id: randomUUID(),
      kind: input.kind,
      title,
      content,
      scope: input.scope,
      ...(scopeRef ? { scopeRef } : {}),
      status: 'active',
      confidence: 'confirmed',
      sensitivity: input.sensitivity ?? 'normal',
      tags: cleanTags(input.tags),
      evidence: input.evidence ?? [],
      pinned: false,
      memoryClass: classForKind(input.kind),
      lifetime: 'durable',
      legacy: false,
      createdAt,
      updatedAt: createdAt
    }
    this.insertWithDailyLimit(memory, currentDate)
    this.exportSnapshot()
    return memory
  }

  private findActiveByFingerprint(
    title: string,
    scope: MemoryScope,
    scopeRef: string | undefined
  ): DurableMemory | null {
    const rows = this.database
      .prepare("SELECT * FROM memories WHERE status = 'active' AND title = ? AND scope = ?")
      .all(title, scope) as MemoryRow[]
    const ref = scopeRef?.trim() ?? ''
    for (const row of rows) {
      const mem = this.hydrate(row)
      if ((mem.scopeRef?.trim() ?? '') === ref) return mem
    }
    return null
  }

  confirm(id: string, patch: UpdateDurableMemoryPatch = {}): DurableMemory | null {
    const current = this.get(id)
    if (!current || current.status !== 'candidate') return null
    return this.update(
      id,
      { ...patch, expiresAt: null },
      { status: 'active', confidence: 'confirmed', rejectionReason: null }
    )
  }

  reject(id: string, reason = '用户拒绝'): DurableMemory | null {
    const current = this.get(id)
    if (!current || current.status !== 'candidate') return null
    return this.update(id, {}, { status: 'archived', rejectionReason: reason.trim() || '用户拒绝' })
  }

  update(
    id: string,
    patch: UpdateDurableMemoryPatch,
    forced: Partial<MemoryRow> = {}
  ): DurableMemory | null {
    const current = this.get(id)
    if (!current) return null
    const title = patch.title === undefined ? current.title : patch.title.trim() || current.title
    const content = patch.content === undefined ? current.content : patch.content.trim()
    if (!content) throw new Error(tr('memory.vault.error.contentEmpty'))
    if (containsSensitiveContent(`${title}\n${content}`)) {
      throw new Error(tr('memory.vault.error.sensitive'))
    }
    const expiresAt =
      patch.expiresAt === null
        ? undefined
        : patch.expiresAt !== undefined
          ? patch.expiresAt
          : current.expiresAt
    const next: DurableMemory = {
      ...current,
      ...(patch.kind ? { kind: patch.kind } : {}),
      title,
      content,
      ...(patch.scope ? { scope: patch.scope } : {}),
      ...(patch.scopeRef === null
        ? {}
        : patch.scopeRef !== undefined
          ? { scopeRef: patch.scopeRef.trim() }
          : current.scopeRef
            ? { scopeRef: current.scopeRef }
            : {}),
      ...(patch.confidence ? { confidence: patch.confidence } : {}),
      ...(patch.sensitivity ? { sensitivity: patch.sensitivity } : {}),
      ...(patch.tags ? { tags: cleanTags(patch.tags) } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      memoryClass: patch.memoryClass ?? current.memoryClass ?? classForKind(patch.kind ?? current.kind),
      lifetime: 'durable',
      legacy: current.legacy,
      ...(patch.validUntil === null
        ? {}
        : patch.validUntil !== undefined
          ? { validUntil: patch.validUntil }
          : current.validUntil
            ? { validUntil: current.validUntil }
            : {}),
      // `current` 可能带有候选过期时间；确认传入 null 时必须显式覆盖，
      // 不能只省略字段，否则 object spread 会把旧 expiresAt 带回去。
      ...(expiresAt ? { expiresAt } : { expiresAt: undefined }),
      status: (forced.status as MemoryStatus | undefined) ?? current.status,
      confidence:
        (forced.confidence as DurableMemory['confidence'] | undefined) ??
        patch.confidence ??
        current.confidence,
      ...(forced.rejectionReason === null
        ? {}
        : forced.rejectionReason
          ? { rejectionReason: forced.rejectionReason }
          : current.rejectionReason
            ? { rejectionReason: current.rejectionReason }
            : {}),
      updatedAt: this.now()
    }
    this.database
      .prepare(
        `UPDATE memories SET kind=?, title=?, content=?, scope=?, scopeRef=?, status=?, confidence=?,
         sensitivity=?, tags=?, pinned=?, updatedAt=?, expiresAt=?, rejectionReason=?, memoryClass=?,
         lifetime=?, legacy=?, validUntil=? WHERE id=?`
      )
      .run(
        next.kind,
        next.title,
        next.content,
        next.scope,
        next.scopeRef ?? null,
        next.status,
        next.confidence,
        next.sensitivity,
        JSON.stringify(next.tags),
        next.pinned ? 1 : 0,
        next.updatedAt,
        next.expiresAt ?? null,
        next.rejectionReason ?? null,
        next.memoryClass ?? classForKind(next.kind),
        'durable',
        next.legacy ? 1 : 0,
        next.validUntil ?? null,
        id
      )
    this.database.prepare('DELETE FROM memories_fts WHERE memoryId = ?').run(id)
    this.database
      .prepare('INSERT INTO memories_fts (memoryId, title, content, tags) VALUES (?, ?, ?, ?)')
      .run(id, next.title, next.content, next.tags.join(' '))
    this.exportSnapshot()
    return this.get(id)
  }

  forget(id: string): void {
    const current = this.get(id)
    this.database.transaction(() => {
      if (current) this.preserveDailyDepositBeforeDelete(current)
      this.database.prepare('DELETE FROM memory_evidence WHERE memoryId = ?').run(id)
      this.database.prepare('DELETE FROM memory_feedback WHERE memoryId = ?').run(id)
      this.database.prepare('DELETE FROM memories_fts WHERE memoryId = ?').run(id)
      this.database.prepare('DELETE FROM memories WHERE id = ?').run(id)
    })()
    this.exportSnapshot()
  }

  feedback(input: MemoryFeedbackInput): void {
    if (!this.get(input.memoryId)) throw new Error(tr('memory.vault.error.notFound'))
    this.database
      .prepare(
        'INSERT INTO memory_feedback (memoryId, outcome, agentId, createdAt) VALUES (?, ?, ?, ?)'
      )
      .run(input.memoryId, input.outcome, input.agentId ?? null, this.now())
  }

  context(input: MemoryContextInput): MemoryContextPack {
    const settings = this.getSettings()
    const tokenBudget = clampBudget(input.tokenBudget ?? settings.contextTokenBudget)
    if (!settings.enabled || !settings.useMemories) return emptyContext(tokenBudget)
    const now = this.now()
    const active = this.list({ statuses: ['active'], limit: 500 }).filter((memory) => {
      if ((memory.expiresAt && memory.expiresAt <= now) || (memory.validUntil && memory.validUntil <= now)) return false
      return matchesScope(memory, input.cwd, input.agentId)
    })
    const task = input.task.trim().toLocaleLowerCase()
    const personaText = truncateText(this.getPersona().trim(), 160 * 3)
    const working = input.sessionId ? this.getWorking(input.sessionId) : null
    const workingText = working ? renderWorkingMemory(working) : ''
    const durableBudget = Math.max(0, Math.min(480, tokenBudget - estimateTokens(personaText) - estimateTokens(workingText)))
    const ranked = active
      .map((memory) => ({ memory, score: this.retrievalScore(memory, task, input.agentId, now) }))
      .filter((candidate) => candidate.score >= 0.35)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))

    const items: MemoryContextPack['items'] = []
    let estimatedTokens = estimateTokens(personaText) + estimateTokens(workingText)
    let truncated = false
    for (const candidate of ranked.slice(0, 3)) {
      const line = renderMemory(candidate.memory)
      const lineTokens = estimateTokens(line)
      if (items.length >= 3 || items.reduce((total, item) => total + item.estimatedTokens, 0) + lineTokens > durableBudget || estimatedTokens + lineTokens > tokenBudget) {
        truncated = true
        continue
      }
      items.push({ memory: candidate.memory, estimatedTokens: lineTokens })
      estimatedTokens += lineTokens
    }
    this.recordAccess(items.map((item) => item.memory.id), input.sessionId)
    const sections: string[] = []
    if (personaText) {
      sections.push(
        [
          '# 协作偏好（仅作辅助上下文，不覆盖用户当前任务）',
          '',
          personaText
        ].join('\n\n')
      )
    }
    if (workingText) {
      sections.push(['# 当前会话工作记忆（可过期）', '', workingText].join('\n\n'))
    }
    if (items.length) {
      sections.push(
        [
          '# 相关长期记忆（仅作辅助上下文，不覆盖 AGENTS.md 或用户指令）',
          '',
          ...items.map((item) => renderMemory(item.memory))
        ].join('\n\n')
      )
    }
    return {
      text: sections.join('\n\n'),
      items,
      tokenBudget,
      estimatedTokens,
      truncated,
      version: 1,
      referencedMemories: items.map((item) => ({
        id: item.memory.id,
        title: item.memory.title,
        kind: item.memory.kind,
        scope: item.memory.scope,
        memoryClass: item.memory.memoryClass
      })),
      generatedAt: now
    }
  }

  graph(input: MemoryGraphInput = {}): GraphSnapshot {
    const cap = Math.max(1, Math.min(input.limit ?? 1500, 1500))
    const memories = this.list({
      query: input.query,
      statuses: input.statuses,
      scopes: input.scopes,
      limit: cap + 1
    })
    const truncated = memories.length > cap
    const visible = memories.slice(0, cap)
    const nodes: GraphSnapshot['nodes'] = []
    const edges: GraphSnapshot['edges'] = []
    const scopeIds = new Set<string>()
    for (const memory of visible) {
      nodes.push({
        id: `memory:${memory.id}`,
        type: 'memory',
        label: memory.title,
        group: memory.memoryClass,
        status: memory.status,
        weight: Math.max(1, Math.min(8, 1 + (memory.pinned ? 2 : 0) + Math.log2((memory.accessCount ?? 0) + 1))),
        muted: memory.status !== 'active'
      })
      const scopeRef = memory.scopeRef ?? memory.scope
      const scopeId = `scope:${memory.scope}:${scopeRef}`
      if (!scopeIds.has(scopeId)) {
        nodes.push({ id: scopeId, type: memory.scope === 'user' ? 'persona' : 'scope', label: scopeRef, group: memory.scope, weight: 3 })
        scopeIds.add(scopeId)
      }
      edges.push({ id: `belongs:${memory.id}:${scopeId}`, source: `memory:${memory.id}`, target: scopeId, relation: 'belongs_to' })
      if (input.includeSources) {
        for (const evidence of memory.evidence.slice(0, 100)) {
          const sourceId = `source:${evidence.sourceType}:${evidence.sourceId}`
          if (!nodes.some((node) => node.id === sourceId)) nodes.push({ id: sourceId, type: 'source-session', label: evidence.sourceId, group: evidence.sourceType, weight: 1 })
          edges.push({ id: `evidence:${memory.id}:${sourceId}`, source: `memory:${memory.id}`, target: sourceId, relation: 'evidenced_by' })
        }
      }
    }
    return {
      nodes,
      edges: input.relations?.length ? edges.filter((edge) => input.relations!.includes(edge.relation)) : edges,
      truncated
    }
  }

  migrateExperiences(entries: ExperienceEntry[]): number {
    const migrated = this.database
      .prepare('SELECT value FROM memory_policies WHERE key = ?')
      .get('legacy-experience-migration-v1') as { value: string } | undefined
    if (migrated) return 0
    let count = 0
    this.database.transaction(() => {
      for (const entry of entries) {
        const existing = this.database.prepare('SELECT id FROM memories WHERE id = ?').get(entry.id)
        if (existing) continue
        const memory: DurableMemory = {
          id: entry.id,
          kind: 'knowledge',
          title: entry.title,
          content: entry.contentMd,
          scope: 'user',
          status: 'active',
          confidence: 'confirmed',
          sensitivity: 'normal',
          tags: cleanTags(entry.tags),
          evidence: entry.sourceSessionId
            ? [{ sourceType: 'session', sourceId: entry.sourceSessionId }]
            : [],
          pinned: false,
          memoryClass: 'semantic',
          lifetime: 'durable',
          legacy: true,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt
        }
        this.insert(memory)
        this.replaceEvidence(memory.id, memory.evidence)
        count += 1
      }
      this.database
        .prepare('INSERT INTO memory_policies (key, value, updatedAt) VALUES (?, ?, ?)')
        .run('legacy-experience-migration-v1', 'done', this.now())
    })()
    this.exportSnapshot()
    return count
  }

  gatewayCapabilities(): MemoryGatewayCapability[] {
    return [
      {
        agentId: 'all',
        transport: 'cli',
        automaticContext: false,
        detail: tr('memory.vault.gateway.allCli')
      },
      {
        agentId: 'mcp',
        transport: 'mcp',
        automaticContext: false,
        detail: tr('memory.vault.gateway.mcp')
      },
      {
        agentId: 'claude',
        transport: 'wrapper',
        automaticContext: false,
        detail: tr('memory.vault.gateway.wrapper')
      },
      {
        agentId: 'codex',
        transport: 'wrapper',
        automaticContext: false,
        detail: tr('memory.vault.gateway.wrapper')
      },
      {
        agentId: 'cursor-agent',
        transport: 'wrapper',
        automaticContext: false,
        detail: tr('memory.vault.gateway.wrapper')
      }
    ]
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL,
        scopeRef TEXT,
        status TEXT NOT NULL,
        confidence TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        tags TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        expiresAt TEXT,
        rejectionReason TEXT,
        memoryClass TEXT,
        lifetime TEXT,
        legacy INTEGER NOT NULL DEFAULT 0,
        lastAccessedAt TEXT,
        accessCount INTEGER NOT NULL DEFAULT 0,
        validFrom TEXT,
        validUntil TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_evidence (
        memoryId TEXT NOT NULL,
        sourceType TEXT NOT NULL,
        sourceId TEXT NOT NULL,
        PRIMARY KEY(memoryId, sourceType, sourceId)
      );
      CREATE TABLE IF NOT EXISTS memory_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memoryId TEXT NOT NULL,
        outcome TEXT NOT NULL,
        agentId TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memoryId TEXT NOT NULL,
        sessionId TEXT,
        accessedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS working_memories (
        sessionId TEXT PRIMARY KEY,
        goal TEXT,
        constraints TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        openQuestions TEXT NOT NULL DEFAULT '[]',
        artifacts TEXT NOT NULL DEFAULT '[]',
        updatedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_policies (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS curation_watermarks (
        sourceId TEXT PRIMARY KEY,
        messageCount INTEGER,
        lastCuratedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_daily_deposits (
        localDate TEXT PRIMARY KEY,
        memoryId TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memoryId UNINDEXED, title, content, tags, tokenize='trigram'
      );
      CREATE INDEX IF NOT EXISTS idx_memories_status_scope ON memories(status, scope, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory ON memory_evidence(memoryId);
      CREATE INDEX IF NOT EXISTS idx_memory_feedback_memory ON memory_feedback(memoryId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_access_memory ON memory_access(memoryId, accessedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_working_memories_expiry ON working_memories(expiresAt);
    `)
  }

  /** SPEC-045：旧 Vault 就地扩展，原文和 evidence 均不改写。 */
  private migrateV2Schema(): void {
    const columns = [
      ['memoryClass', 'TEXT'],
      ['lifetime', 'TEXT'],
      ['legacy', 'INTEGER NOT NULL DEFAULT 0'],
      ['lastAccessedAt', 'TEXT'],
      ['accessCount', 'INTEGER NOT NULL DEFAULT 0'],
      ['validFrom', 'TEXT'],
      ['validUntil', 'TEXT']
    ] as const
    for (const [name, definition] of columns) {
      try {
        this.database.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`)
      } catch {
        // 已升级的库或全新库均无需处理。
      }
    }
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE memories SET memoryClass = CASE kind
            WHEN 'preference' THEN 'identity'
            WHEN 'convention' THEN 'procedural'
            WHEN 'procedure' THEN 'procedural'
            WHEN 'pitfall' THEN 'procedural'
            ELSE 'semantic' END,
            lifetime = 'durable', legacy = 1
           WHERE memoryClass IS NULL OR lifetime IS NULL`
        )
        .run()
      this.database
        .prepare('UPDATE memories SET accessCount = COALESCE(accessCount, 0)')
        .run()
    })()
  }

  private archiveExpiredCandidates(): void {
    this.database
      .prepare(
        `UPDATE memories
         SET status = 'archived', rejectionReason = COALESCE(rejectionReason, '候选超过 30 天未处理'), updatedAt = ?
         WHERE status = 'candidate' AND expiresAt IS NOT NULL AND expiresAt <= ?`
      )
      .run(this.now(), this.now())
  }

  /**
   * 在 IMMEDIATE 事务中领取每日唯一槽位并写入记忆。独立进程/连接并发时，SQLite
   * 会先串行化写事务，再由 localDate 主键保证最多一个成功。
   */
  private insertWithDailyLimit(memory: DurableMemory, date: Date): void {
    const key = localDateKey(date)
    const { start, end } = localDayWindow(date)
    let inserted = false
    const write = this.database.transaction(() => {
      const occupied = this.database
        .prepare('SELECT memoryId FROM memory_daily_deposits WHERE localDate = ?')
        .get(key) as { memoryId: string } | undefined
      if (occupied) return

      // 升级兼容：新表尚无占用记录，但旧版本今天已经写过记忆时，回填该占用。
      const existing = this.database
        .prepare(
          'SELECT id FROM memories WHERE createdAt >= ? AND createdAt < ? ORDER BY createdAt ASC LIMIT 1'
        )
        .get(start, end) as { id: string } | undefined
      if (existing) {
        this.database
          .prepare(
            'INSERT INTO memory_daily_deposits (localDate, memoryId, createdAt) VALUES (?, ?, ?)'
          )
          .run(key, existing.id, this.now())
        return
      }

      this.database
        .prepare(
          'INSERT INTO memory_daily_deposits (localDate, memoryId, createdAt) VALUES (?, ?, ?)'
        )
        .run(key, memory.id, memory.createdAt)
      this.insert(memory)
      this.replaceEvidence(memory.id, memory.evidence)
      inserted = true
    })
    write.immediate()
    if (!inserted) throw new Error(tr('memory.vault.error.dailyDepositLimit'))
  }

  private preserveDailyDepositBeforeDelete(memory: DurableMemory): void {
    const date = this.clock()
    const { start, end } = localDayWindow(date)
    if (memory.createdAt < start || memory.createdAt >= end) return
    this.database
      .prepare(
        `INSERT OR IGNORE INTO memory_daily_deposits (localDate, memoryId, createdAt)
         VALUES (?, ?, ?)`
      )
      .run(localDateKey(date), memory.id, memory.createdAt)
  }

  private now(): string {
    return this.clock().toISOString()
  }

  private insert(memory: DurableMemory): void {
    this.database
      .prepare(
        `INSERT INTO memories (
          id, kind, title, content, scope, scopeRef, status, confidence, sensitivity,
          tags, pinned, createdAt, updatedAt, expiresAt, rejectionReason, memoryClass, lifetime,
          legacy, lastAccessedAt, accessCount, validFrom, validUntil
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memory.id,
        memory.kind,
        memory.title,
        memory.content,
        memory.scope,
        memory.scopeRef ?? null,
        memory.status,
        memory.confidence,
        memory.sensitivity,
        JSON.stringify(memory.tags),
        memory.pinned ? 1 : 0,
        memory.createdAt,
        memory.updatedAt,
        memory.expiresAt ?? null,
        memory.rejectionReason ?? null,
        memory.memoryClass ?? classForKind(memory.kind),
        'durable',
        memory.legacy ? 1 : 0,
        memory.lastAccessedAt ?? null,
        memory.accessCount ?? 0,
        memory.validFrom ?? null,
        memory.validUntil ?? null
      )
    this.database
      .prepare('INSERT INTO memories_fts (memoryId, title, content, tags) VALUES (?, ?, ?, ?)')
      .run(memory.id, memory.title, memory.content, memory.tags.join(' '))
  }

  private replaceEvidence(memoryId: string, evidence: MemoryEvidence[]): void {
    this.database.prepare('DELETE FROM memory_evidence WHERE memoryId = ?').run(memoryId)
    const insert = this.database.prepare(
      'INSERT OR IGNORE INTO memory_evidence (memoryId, sourceType, sourceId) VALUES (?, ?, ?)'
    )
    for (const item of evidence) insert.run(memoryId, item.sourceType, item.sourceId)
  }

  private hydrate(row: MemoryRow): DurableMemory {
    const evidence = this.database
      .prepare('SELECT sourceType, sourceId FROM memory_evidence WHERE memoryId = ?')
      .all(row.id) as MemoryEvidence[]
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      scope: row.scope,
      ...(row.scopeRef ? { scopeRef: row.scopeRef } : {}),
      status: row.status,
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      tags: parseTags(row.tags),
      evidence,
      pinned: Boolean(row.pinned),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      memoryClass: row.memoryClass ?? classForKind(row.kind),
      lifetime: 'durable',
      legacy: Boolean(row.legacy),
      ...(row.lastAccessedAt ? { lastAccessedAt: row.lastAccessedAt } : {}),
      ...(row.accessCount ? { accessCount: row.accessCount } : {}),
      ...(row.validFrom ? { validFrom: row.validFrom } : {}),
      ...(row.validUntil ? { validUntil: row.validUntil } : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      ...(row.rejectionReason ? { rejectionReason: row.rejectionReason } : {})
    }
  }

  private exportSnapshot(): void {
    const memories = this.list({ statuses: ['active'], limit: 500 })
    mkdirSync(dirname(this.exportPath), { recursive: true, mode: 0o700 })
    const markdown = [
      '# Agent OS 长期记忆（生成快照）',
      '',
      '> 此文件由 Agent OS 生成，仅用于审计、备份和迁移；请在应用中管理条目。',
      '',
      ...memories.flatMap((memory) => [
        `## ${memory.title}`,
        '',
        `- id: ${memory.id}`,
        `- kind: ${memory.kind}`,
        `- scope: ${memory.scope}${memory.scopeRef ? ` (${memory.scopeRef})` : ''}`,
        `- evidence: ${memory.evidence.map((item) => `${item.sourceType}:${item.sourceId}`).join(', ') || 'none'}`,
        '',
        memory.content,
        ''
      ])
    ].join('\n')
    writeFileSync(this.exportPath, markdown, { encoding: 'utf8', mode: 0o600 })
  }

  private retrievalScore(
    memory: DurableMemory,
    task: string,
    agentId: string | undefined,
    now: string
  ): number {
    const rows = this.database
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM memory_feedback
         WHERE memoryId = ? GROUP BY outcome`
      )
      .all(memory.id) as Array<{ outcome: string; count: number }>
    const feedback = new Map(rows.map((row) => [row.outcome, row.count]))
    if ((feedback.get('wrong') ?? 0) > 0) return 0
    const terms = queryTerms(task)
    const haystack = `${memory.title}\n${memory.content}\n${memory.tags.join(' ')}`.toLocaleLowerCase()
    const matching = terms.filter((term) => haystack.includes(term)).length
    // 始终应用的人格块可在没有任务关键词时进入；其余条目必须与任务有词面关联。
    // 中文任务通常只有一个长词串；只按「命中词数/片段数」会把“准备发布”→“发布”
    // 这种明确的局部命中压得过低。任一片段命中应具备最低相关度，仍由作用域、反馈和
    // 衰减继续收敛，避免置顶或泛化记忆绕过相关性门槛。
    const lexical = terms.length
      ? matching > 0 ? Math.max(matching / terms.length, 0.6) : 0
      : memory.memoryClass === 'identity' ? 0.5 : 0
    if (terms.length && matching === 0) return 0
    const scopeFactor: Record<MemoryScope, number> = {
      path: 1,
      repo: 1,
      project: 0.9,
      user: 0.75,
      agent: memory.scopeRef === agentId ? 0.65 : 0
    }
    const ageDays = Math.max(0, (Date.parse(now) - Date.parse(memory.lastAccessedAt ?? memory.updatedAt)) / 86_400_000)
    const memoryClass = memory.memoryClass ?? classForKind(memory.kind)
    const decayConfig: Record<MemoryClass, { halfLife: number; floor: number }> = {
      identity: { halfLife: 365, floor: 0.9 },
      procedural: { halfLife: 180, floor: 0.7 },
      semantic: { halfLife: 60, floor: 0.5 },
      episodic: { halfLife: 14, floor: 0.3 }
    }
    const decay = decayConfig[memoryClass]
    const freshness = decay.floor + (1 - decay.floor) * 2 ** (-ageDays / decay.halfLife)
    const recentAccess = this.database
      .prepare('SELECT COUNT(*) AS count FROM memory_access WHERE memoryId = ? AND accessedAt >= ?')
      .get(memory.id, new Date(Date.parse(now) - 30 * 86_400_000).toISOString()) as { count: number }
    const accessBoost = Math.min(1.5, 1 + Math.min(5, recentAccess.count) * 0.1)
    const feedbackFactor = (feedback.get('stale') ?? 0) > 0 ? 0.5 : (feedback.get('useful') ?? 0) > 0 ? 1.1 : 1
    const confidence = memory.confidence === 'confirmed' ? 1 : 0.85
    const pinned = memory.pinned ? 1.15 : 1
    return Math.min(1, lexical * scopeFactor[memory.scope] * freshness * accessBoost * feedbackFactor * confidence * pinned)
  }

  private recordAccess(ids: string[], sessionId: string | undefined): void {
    if (!ids.length) return
    const now = this.now()
    const write = this.database.transaction(() => {
      const access = this.database.prepare(
        'INSERT INTO memory_access (memoryId, sessionId, accessedAt) VALUES (?, ?, ?)'
      )
      const update = this.database.prepare(
        'UPDATE memories SET lastAccessedAt = ?, accessCount = COALESCE(accessCount, 0) + 1 WHERE id = ?'
      )
      const prune = this.database.prepare(
        `DELETE FROM memory_access WHERE memoryId = ? AND id NOT IN (
          SELECT id FROM memory_access WHERE memoryId = ? ORDER BY accessedAt DESC, id DESC LIMIT 20
        )`
      )
      for (const id of ids) {
        access.run(id, sessionId ?? null, now)
        update.run(now, id)
        prune.run(id, id)
      }
    })
    write.immediate()
  }

  private expireWorking(): void {
    this.database.prepare('DELETE FROM working_memories WHERE expiresAt <= ?').run(this.now())
  }

  private hydrateWorking(row: WorkingMemoryRow): WorkingMemoryState {
    return {
      sessionId: row.sessionId,
      ...(row.goal?.trim() ? { goal: row.goal.trim() } : {}),
      constraints: parseStringList(row.constraints),
      decisions: parseStringList(row.decisions),
      openQuestions: parseStringList(row.openQuestions),
      artifacts: parseStringList(row.artifacts),
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt
    }
  }
}

function clampBudget(value: number): number {
  return Math.max(200, Math.min(Math.round(value), 2_000))
}

function emptyContext(tokenBudget: number): MemoryContextPack {
  return {
    version: 1,
    text: '',
    referencedMemories: [],
    generatedAt: new Date().toISOString(),
    items: [],
    tokenBudget,
    estimatedTokens: 0,
    truncated: false
  }
}

function matchesScope(memory: DurableMemory, cwd: string, agentId: string | undefined): boolean {
  if (memory.scope === 'user') return true
  if (memory.scope === 'agent') return Boolean(agentId && memory.scopeRef === agentId)
  if (!memory.scopeRef) return false
  if (memory.scope === 'project' || memory.scope === 'repo')
    return safePathStartsWith(cwd, memory.scopeRef)
  return memory.scope === 'path' && safePathStartsWith(cwd, memory.scopeRef)
}

function renderMemory(memory: DurableMemory): string {
  return `- [${memory.memoryClass ?? classForKind(memory.kind)} · ${memory.scope}] ${memory.title}\n  ${memory.content}`
}

function queryTerms(task: string): string[] {
  const words = task.toLocaleLowerCase().split(/\s+/u).map((term) => term.trim()).filter(Boolean)
  // 连续中文无空格时按 2–4 字片段补充候选，避免只依赖整句精确命中。
  if (words.length === 1 && Array.from(words[0] ?? '').length >= 4) {
    const chars = Array.from(words[0] ?? '')
    for (let index = 0; index < chars.length - 1; index += 2) words.push(chars.slice(index, index + 3).join(''))
  }
  return [...new Set(words)].filter(Boolean)
}

function truncateText(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join('')
}

function cleanWorkingItems(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, 12)
}

function renderWorkingMemory(memory: WorkingMemoryState): string {
  const sections = [
    memory.goal ? `目标：${memory.goal}` : '',
    memory.constraints.length ? `约束：${memory.constraints.join('；')}` : '',
    memory.decisions.length ? `已决定：${memory.decisions.join('；')}` : '',
    memory.openQuestions.length ? `待确认：${memory.openQuestions.join('；')}` : '',
    memory.artifacts.length ? `产物：${memory.artifacts.join('；')}` : ''
  ].filter(Boolean)
  return truncateText(sections.join('\n'), 320 * 3)
}
