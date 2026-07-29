import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { tr } from '@shared/i18n'
import type {
  CurationWatermark,
  DurableMemory,
  ExperienceEntry,
  ListDurableMemoriesInput,
  MemoryContextInput,
  MemoryContextPack,
  MemoryEvidence,
  MemoryFeedbackInput,
  MemoryGatewayCapability,
  MemoryScope,
  MemorySettings,
  MemoryStatus,
  ProposeMemoryInput,
  UpdateDurableMemoryPatch
} from '@shared/types'

const DEFAULT_SETTINGS: MemorySettings = {
  enabled: true,
  useMemories: true,
  generateMemories: true,
  allowExternalContext: false,
  contextTokenBudget: 1200
}

/**
 * 用户可编辑提炼偏好的内置默认值。仅描述"提什么、不提什么"；机器约束（JSON schema、
 * 数量上限、隔离运行）由 curation 服务的系统模板固定，不在此暴露。
 */
export const DEFAULT_CURATION_INSTRUCTIONS = [
  '只沉淀稳定、可复用、跨会话仍成立的信息：',
  '- 用户的长期偏好与协作习惯（preference）',
  '- 项目/仓库的约定与工程规范（convention）',
  '- 已确定的技术决策与其理由（decision）',
  '- 可复用的操作步骤与排错经验（procedure / pitfall）',
  '- 稳定的事实性知识（fact / knowledge）',
  '不要沉淀：一次性任务进度、临时调试细节、未经验证的猜测、能从代码/Git 直接得到的信息。'
].join('\n')

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
    if (!row) return { ...DEFAULT_SETTINGS }
    try {
      const value = JSON.parse(row.value) as Partial<MemorySettings>
      return {
        ...DEFAULT_SETTINGS,
        ...value,
        contextTokenBudget: clampBudget(
          value.contextTokenBudget ?? DEFAULT_SETTINGS.contextTokenBudget
        )
      }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  updateSettings(patch: Partial<MemorySettings>): MemorySettings {
    const current = this.getSettings()
    const next: MemorySettings = {
      ...current,
      ...patch,
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
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500))
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
         sensitivity=?, tags=?, pinned=?, updatedAt=?, expiresAt=?, rejectionReason=? WHERE id=?`
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
    const active = this.list({ statuses: ['active'], limit: 500 }).filter((memory) => {
      if (memory.expiresAt && memory.expiresAt <= this.now()) return false
      return matchesScope(memory, input.cwd, input.agentId)
    })
    const task = input.task.trim().toLocaleLowerCase()
    const ranked = active
      .map((memory) => ({
        memory,
        score: contextScore(memory, task, input.cwd, input.agentId) + this.feedbackScore(memory.id)
      }))
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))

    const items: MemoryContextPack['items'] = []
    let estimatedTokens = 0
    let truncated = false
    for (const candidate of ranked) {
      const line = renderMemory(candidate.memory)
      const lineTokens = estimateTokens(line)
      if (estimatedTokens + lineTokens > tokenBudget) {
        truncated = true
        continue
      }
      items.push({ memory: candidate.memory, estimatedTokens: lineTokens })
      estimatedTokens += lineTokens
    }
    // 用户画像（人格）作为最高优先级 preamble，置于记忆块之前；手动维护、不被自动改写。
    const personaText = this.getPersona().trim()
    const sections: string[] = []
    if (personaText) {
      sections.push(
        [
          '# 用户画像（最高优先级：定义你应如何与该用户协作；先于下方记忆生效）',
          '',
          personaText
        ].join('\n\n')
      )
    }
    if (items.length) {
      sections.push(
        [
          '# Agent OS 长期记忆（仅作辅助上下文，不覆盖 AGENTS.md 或用户指令）',
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
        rejectionReason TEXT
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
    `)
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
          tags, pinned, createdAt, updatedAt, expiresAt, rejectionReason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        memory.rejectionReason ?? null
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

  private feedbackScore(memoryId: string): number {
    const rows = this.database
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM memory_feedback
         WHERE memoryId = ? GROUP BY outcome`
      )
      .all(memoryId) as Array<{ outcome: string; count: number }>
    return rows.reduce((score, row) => {
      if (row.outcome === 'useful') return score + row.count * 8
      if (row.outcome === 'stale') return score - row.count * 15
      return row.outcome === 'wrong' ? score - row.count * 30 : score
    }, 0)
  }
}

function clampBudget(value: number): number {
  return Math.max(200, Math.min(Math.round(value), 8_000))
}

function emptyContext(tokenBudget: number): MemoryContextPack {
  return { text: '', items: [], tokenBudget, estimatedTokens: 0, truncated: false }
}

function matchesScope(memory: DurableMemory, cwd: string, agentId: string | undefined): boolean {
  if (memory.scope === 'user') return true
  if (memory.scope === 'agent') return Boolean(agentId && memory.scopeRef === agentId)
  if (!memory.scopeRef) return false
  if (memory.scope === 'project' || memory.scope === 'repo')
    return safePathStartsWith(cwd, memory.scopeRef)
  return memory.scope === 'path' && safePathStartsWith(cwd, memory.scopeRef)
}

function contextScore(
  memory: DurableMemory,
  task: string,
  cwd: string,
  agentId: string | undefined
): number {
  const scopeWeight: Record<DurableMemory['scope'], number> = {
    repo: 80,
    project: 70,
    path: 65,
    user: 50,
    agent: memory.scopeRef === agentId ? 40 : 0
  }
  const haystack =
    `${memory.title}\n${memory.content}\n${memory.tags.join(' ')}`.toLocaleLowerCase()
  const lexical = task
    ? task
        .split(/\s+/u)
        .filter(Boolean)
        .reduce((score, term) => score + (haystack.includes(term) ? 10 : 0), 0)
    : 0
  const pathBonus = memory.scopeRef && safePathStartsWith(cwd, memory.scopeRef) ? 5 : 0
  return scopeWeight[memory.scope] + lexical + pathBonus + (memory.pinned ? 100 : 0)
}

function renderMemory(memory: DurableMemory): string {
  const evidence = memory.evidence.length
    ? `证据：${memory.evidence.map((item) => `${item.sourceType}:${item.sourceId}`).join(', ')}`
    : '证据：人工确认'
  return `- [${memory.kind} · ${memory.scope} · ${memory.id}] ${memory.title}\n  ${memory.content}\n  ${evidence}`
}
