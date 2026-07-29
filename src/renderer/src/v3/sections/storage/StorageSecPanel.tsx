// 存储镜头二级面板。UI 复刻原型 StoragePanel（会话/记忆/知识三栏），接真实数据。
// 会话：sessionsStore.views + 回放；记忆：experience CRUD + memory.indexStatus；知识：占位（延后）。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AnnotationBrowseEntry,
  AnnotationDisplayMeta,
  AnnotationTargetRef,
  DurableMemory,
  MemoryIndexStatus,
  MemorySearchHit
} from '@shared/types'
import { annotationTargetKey } from '@shared/types'
import { sanitizeTranscriptTitle } from '@shared/transcript/title'
import { useSessionsStore } from '../../../stores/sessionsStore'
import { useAnnotationsStore } from '../../../stores/annotationsStore'
import { ToolIcon } from '../../../lib/toolIcons'
import { relativeTime, groupByMonth } from '../../../lib/time'
import { TagEditor } from './TagEditor'
import { useT } from '../../../lib/i18n'
import { getCurrentRendererLang } from '../../../lib/i18n'
import { tr, localeFor } from '@shared/i18n'
import { sessionDisplayTitle } from '../../../lib/sessionTitle'

// 展示期净化：存量索引里的标题可能含 <system-reminder>/<command-name> 等噪声、UUID 文件名等，渲染时兜底净化。
function displayTitle(raw: string, lastActivityAt?: string): string {
  const sanitized = sanitizeTranscriptTitle(raw) || ''
  if (sanitized) return sanitized
  // 净化后为空（UUID/元数据文件名/系统文本）：用活跃时间生成可读标题。
  if (lastActivityAt) {
    const d = new Date(lastActivityAt)
    if (!Number.isNaN(d.getTime())) {
      const date = d.toLocaleDateString(localeFor(getCurrentRendererLang()), { month: 'short', day: 'numeric' })
      return tr('memory.time.fullDateFallback', { date })
    }
  }
  return tr('memory.storage.historyConv')
}

const IcSearch = (): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8.9 8.9L12 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
)

function SearchBox({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder: string }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        background: 'var(--bg-active)',
        borderRadius: 7,
        marginBottom: 4
      }}
    >
      <IcSearch />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 11, color: 'var(--text-primary)', fontFamily: 'inherit' }}
      />
    </div>
  )
}

// 把一条会话命中转成标注层 conversation ref（自建 vs CLI）。
function conversationRefOf(hit: MemorySearchHit): AnnotationTargetRef {
  return hit.source === 'agent'
    ? { kind: 'conversation', source: 'managed', convId: hit.sessionId }
    : { kind: 'conversation', source: 'cli', toolId: hit.toolId, nativeSessionId: hit.nativeSessionId }
}

// 标注目标 → 打开记录所用的 id（会话本身，或消息所属会话）。
function navIdOf(ref: AnnotationTargetRef): string {
  if (ref.kind === 'conversation') {
    return ref.source === 'managed' ? ref.convId : `${ref.toolId}:${ref.nativeSessionId}`
  }
  return ref.source === 'managed' ? ref.sessionId : `${ref.toolId}:${ref.nativeSessionId}`
}

// ─── 统一记录列表的筛选维度（方案一：左菜单不变，列表区一条多条件过滤） ──────────
type SourceFilter = 'all' | 'agent' | 'cli'
type TimeFilter = 'all' | 'today' | '7d' | '30d'

function withinTime(iso: string | undefined, f: TimeFilter): boolean {
  if (f === 'all') return true
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  if (f === 'today') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return t >= start.getTime()
  }
  const days = f === '7d' ? 7 : 30
  return Date.now() - t <= days * 86_400_000
}

// 统一列表行：会话命中 + 标注层条目（含消息级）归一成同一形状。
interface UnifiedRow {
  key: string
  navId: string
  ref: AnnotationTargetRef
  kind: 'conversation' | 'message'
  source: 'managed' | 'cli'
  title: string
  toolId: string
  favorite: boolean
  tags: string[]
  time: string
}

function rowFromAnnoEntry(entry: AnnotationBrowseEntry): UnifiedRow {
  return {
    key: annotationTargetKey(entry.ref),
    navId: navIdOf(entry.ref),
    ref: entry.ref,
    kind: entry.ref.kind,
    source: entry.ref.source,
    title: entry.label || tr('memory.storage.untitled'),
    toolId: entry.toolId,
    favorite: entry.favorite,
    tags: entry.tags,
    time: entry.updatedAt || ''
  }
}

function HistoryList({
  onOpenRecord,
  activeRecordId
}: {
  onOpenRecord(rec: { id: string; title: string }): void
  activeRecordId: string | null
}): React.JSX.Element {
  const { t } = useT()
  const views = useSessionsStore((s) => s.views)
  const toggleFavorite = useSessionsStore((s) => s.toggleFavorite)
  const annotations = useAnnotationsStore((s) => s.entries)
  const loadMany = useAnnotationsStore((s) => s.loadMany)
  const toggleAnnoFavorite = useAnnotationsStore((s) => s.toggleFavorite)
  const refreshTags = useAnnotationsStore((s) => s.refreshTags)
  const tagCounts = useAnnotationsStore((s) => s.tagCounts)
  const listAnnotated = useAnnotationsStore((s) => s.listAnnotated)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemorySearchHit[]>([])
  const [annoRows, setAnnoRows] = useState<AnnotationBrowseEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ ref: AnnotationTargetRef; meta: AnnotationDisplayMeta } | null>(null)

  // 筛选维度：时间 / 来源 / 收藏 / 标签（多选取交集）。
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [tagFilterOpen, setTagFilterOpen] = useState(false)

  // 收藏状态来自实时 view（仅自建会话有），按 id 查。
  const viewById = useMemo(() => new Map(views.map((v) => [v.id, v])), [views])

  // 统一搜索：空 query=最近列表，非空=标题+正文跨「自建 agent 对话 + CLI 历史」。
  // 依赖 views 变化触发刷新（新会话/收藏切换后即时反映）。
  useEffect(() => {
    let alive = true
    const q = query.trim()
    setLoading(true)
    const timer = setTimeout(() => {
      void window.agentOs.session
        .search({ query: q, limit: 200 })
        .then((r) => { if (alive) setResults(r) })
        .catch(() => { if (alive) setResults([]) })
        .finally(() => { if (alive) setLoading(false) })
    }, q ? 250 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, views])

  // 标注层条目（含消息级收藏/标签）：收藏与标签过滤的真源之一，单独拉取并合并。
  const reloadAnno = useCallback(() => {
    void listAnnotated().then(setAnnoRows).catch(() => setAnnoRows([]))
  }, [listAnnotated])

  // 首次进入刷新标签计数 + 标注条目。
  useEffect(() => {
    void refreshTags()
    reloadAnno()
  }, [refreshTags, reloadAnno])

  // 为每条搜索结果构建 conversation ref（自建 vs CLI），预取标注（收藏星 + 标签 chip）。
  const refsByKey = useMemo(() => {
    const map = new Map<string, AnnotationTargetRef>()
    for (const hit of results) map.set(hit.sessionId, conversationRefOf(hit))
    return map
  }, [results])
  useEffect(() => {
    void loadMany(Array.from(refsByKey.values()))
  }, [refsByKey, loadMany])

  // 合并三源 → 统一行：① 搜索命中（会话级）② 标注条目（含消息级）③ managed 会话收藏（真源在 view）。
  const allRows = useMemo(() => {
    const byKey = new Map<string, UnifiedRow>()
    // ① 搜索命中
    for (const hit of results) {
      const ref = conversationRefOf(hit)
      const key = annotationTargetKey(ref)
      const view = hit.source === 'agent' ? viewById.get(hit.sessionId) : undefined
      const anno = annotations.get(key) ?? { favorite: false, tags: [] }
      byKey.set(key, {
        key,
        navId: hit.sessionId,
        ref,
        kind: 'conversation',
        source: hit.source === 'agent' ? 'managed' : 'cli',
        title: displayTitle(hit.title, hit.lastActivityAt),
        toolId: hit.toolId,
        favorite: hit.source === 'agent' ? !!view?.favorite : anno.favorite,
        tags: anno.tags,
        time: hit.lastActivityAt || ''
      })
    }
    // ② 标注条目（消息级 / 未进入搜索结果的旧会话）
    const q = query.trim().toLowerCase()
    for (const entry of annoRows) {
      const row = rowFromAnnoEntry(entry)
      if (byKey.has(row.key)) continue
      if (q && !row.title.toLowerCase().includes(q)) continue
      byKey.set(row.key, row)
    }
    // ③ managed 会话收藏（SPEC-020 真源在 view，可能不在搜索/标注里）
    for (const v of views) {
      if (!v.favorite) continue
      const ref: AnnotationTargetRef = { kind: 'conversation', source: 'managed', convId: v.id }
      const key = annotationTargetKey(ref)
      const existing = byKey.get(key)
      if (existing) { existing.favorite = true; continue }
      const title = sessionDisplayTitle(v)
      if (q && !title.toLowerCase().includes(q) && !(v.name || '').toLowerCase().includes(q)) continue
      byKey.set(key, {
        key,
        navId: v.id,
        ref,
        kind: 'conversation',
        source: 'managed',
        title,
        toolId: v.toolId,
        favorite: true,
        tags: annotations.get(key)?.tags ?? [],
        time: v.lastActivityAt || ''
      })
    }
    return [...byKey.values()]
  }, [results, annoRows, views, viewById, annotations, query])

  // 应用筛选 + 按时间倒序。
  const rows = useMemo(() => {
    const tagSet = selectedTags.map((t) => t.toLowerCase())
    return allRows
      .filter((r) => {
        if (sourceFilter !== 'all' && (sourceFilter === 'agent' ? r.source !== 'managed' : r.source !== 'cli')) return false
        if (favoriteOnly && !r.favorite) return false
        if (!withinTime(r.time, timeFilter)) return false
        if (tagSet.length > 0) {
          const lower = r.tags.map((t) => t.toLowerCase())
          if (!tagSet.every((t) => lower.includes(t))) return false
        }
        return true
      })
      .sort((a, b) => b.time.localeCompare(a.time))
  }, [allRows, sourceFilter, favoriteOnly, timeFilter, selectedTags])

  const toggleTag = (tag: string): void => {
    setSelectedTags((prev) =>
      prev.some((t) => t.toLowerCase() === tag.toLowerCase())
        ? prev.filter((t) => t.toLowerCase() !== tag.toLowerCase())
        : [...prev, tag]
    )
  }

  const handleToggleFavorite = (row: UnifiedRow): void => {
    if (row.kind === 'conversation' && row.source === 'managed') {
      const view = viewById.get(row.navId)
      void toggleFavorite(row.navId, !(view?.favorite ?? row.favorite))
    } else {
      void toggleAnnoFavorite(row.ref, !row.favorite, { label: row.title, toolId: row.toolId }).then(reloadAnno)
    }
  }

  const timeOpts: { k: TimeFilter; label: string }[] = [
    { k: 'all', label: t('memory.storage.time.all') },
    { k: 'today', label: t('memory.storage.time.today') },
    { k: '7d', label: t('memory.storage.time.d7') },
    { k: '30d', label: t('memory.storage.time.d30') }
  ]
  const sourceOpts: { k: SourceFilter; label: string }[] = [
    { k: 'all', label: t('memory.storage.source.all') },
    { k: 'agent', label: t('memory.storage.source.agent') },
    { k: 'cli', label: t('memory.storage.source.cli') }
  ]

  // 已选条件 chip（仅展示非默认条件，便于一眼看清「为什么只看到这些」）。
  const conds: { label: string; clear(): void }[] = []
  if (timeFilter !== 'all') conds.push({ label: timeOpts.find((o) => o.k === timeFilter)!.label, clear: () => setTimeFilter('all') })
  if (sourceFilter !== 'all') conds.push({ label: sourceFilter === 'agent' ? t('memory.storage.source.agent') : t('memory.storage.source.cli'), clear: () => setSourceFilter('all') })
  if (favoriteOnly) conds.push({ label: `★ ${t('memory.storage.filterLabel.favorite')}`, clear: () => setFavoriteOnly(false) })
  for (const tag of selectedTags) conds.push({ label: `#${tag}`, clear: () => toggleTag(tag) })
  const clearAll = (): void => {
    setTimeFilter('all'); setSourceFilter('all'); setFavoriteOnly(false); setSelectedTags([])
  }

  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder={t('memory.storage.searchPlaceholder')} />

      <div className="stor-filter">
        <div className="stor-filter__row">
          <span className="stor-filter__label">{t('memory.storage.filterLabel.time')}</span>
          <div className="stor-filter__opts">
            {timeOpts.map((o) => (
              <button
                key={o.k}
                type="button"
                className={`stor-seg ${timeFilter === o.k ? 'is-active' : ''}`}
                onClick={() => setTimeFilter(o.k)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="stor-filter__row">
          <span className="stor-filter__label">{t('memory.storage.filterLabel.source')}</span>
          <div className="stor-filter__opts">
            {sourceOpts.map((o) => (
              <button
                key={o.k}
                type="button"
                className={`stor-seg ${sourceFilter === o.k ? 'is-active' : ''}`}
                onClick={() => setSourceFilter(o.k)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="stor-filter__row">
          <span className="stor-filter__label">{t('memory.storage.filterLabel.favorite')}</span>
          <div className="stor-filter__opts">
            <button
              type="button"
              className={`stor-seg ${favoriteOnly ? 'is-active' : ''}`}
              onClick={() => setFavoriteOnly((v) => !v)}
            >
              {t('memory.storage.favoriteOnly')}
            </button>
          </div>
        </div>
        <div className="stor-filter__row stor-filter__row--tags">
          <span className="stor-filter__label">{t('memory.storage.filterLabel.tags')}</span>
          <div className="stor-filter__tag-select">
            {tagCounts.length === 0 ? (
              <span className="stor-filter__hint">{t('memory.storage.noTags')}</span>
            ) : (
              <>
                <button
                  type="button"
                  className={`stor-tag-trigger ${tagFilterOpen ? 'is-active' : ''}`}
                  onClick={() => setTagFilterOpen((v) => !v)}
                >
                  {selectedTags.length > 0
                    ? `${t('memory.storage.filterLabel.tags')} · ${selectedTags.length}`
                    : `${t('memory.storage.filterLabel.tags')} · ${tagCounts.length}`}
                  <span className="stor-tag-trigger__chev">{tagFilterOpen ? '⌃' : '⌄'}</span>
                </button>
                {selectedTags.length > 0 ? (
                  <span className="stor-tag-selected">
                    {selectedTags.slice(0, 3).map((tag) => (
                      <button key={tag} type="button" className="anno-tag-chip is-active" onClick={() => toggleTag(tag)}>
                        {tag}
                      </button>
                    ))}
                    {selectedTags.length > 3 ? <span className="anno-tag-chip is-active">+{selectedTags.length - 3}</span> : null}
                  </span>
                ) : null}
                {tagFilterOpen ? (
                  <div className="stor-tag-menu">
                    {tagCounts.map((c) => {
                      const active = selectedTags.some((tg) => tg.toLowerCase() === c.tag.toLowerCase())
                      return (
                        <button
                          key={c.tag}
                          type="button"
                          className={`stor-tag-menu__item ${active ? 'is-active' : ''}`}
                          onClick={() => {
                            toggleTag(c.tag)
                            setTagFilterOpen(false)
                          }}
                          title={`${c.tag} (${c.count})`}
                        >
                          <span className="stor-tag-menu__check">{active ? '✓' : ''}</span>
                          <span className="stor-tag-menu__name">{c.tag}</span>
                          <span className="stor-tag-menu__count">{c.count}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      {conds.length > 0 && (
        <div className="stor-conds">
          {conds.map((c, i) => (
            <button key={`${c.label}:${i}`} type="button" className="stor-cond" onClick={c.clear} title={t('memory.storage.removeCondAria')}>
              {c.label}
              <span className="stor-cond__x">✕</span>
            </button>
          ))}
          <button type="button" className="stor-cond stor-cond--clear" onClick={clearAll}>{t('memory.storage.clearAll')}</button>
        </div>
      )}

      {rows.length === 0 && (
        <div style={{ padding: '10px 9px', fontSize: 11, color: 'var(--text-muted)' }}>
          {loading ? t('memory.storage.searching') : conds.length > 0 ? t('memory.storage.noMatch') : t('memory.storage.empty')}
        </div>
      )}

      {rows.map((row) => (
        <div
          key={row.key}
          className={`session-item ${activeRecordId === row.navId ? 'is-active' : ''}`}
          onClick={() => onOpenRecord({ id: row.navId, title: row.title })}
        >
          <ToolIcon toolId={row.toolId} size={16} brandColor />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div className="session-item__name" style={{ flex: 1, minWidth: 0 }}>
                {row.kind === 'message' ? <span className="anno-kind-badge">{t('memory.storage.messageKind')}</span> : null}
                {row.title}
              </div>
              <button
                type="button"
                className={`anno-star ${row.favorite ? 'is-active' : ''}`}
                aria-label={row.favorite ? t('memory.storage.unstarAria') : t('memory.storage.starAria')}
                onClick={(e) => {
                  e.stopPropagation()
                  handleToggleFavorite(row)
                }}
              >
                {row.favorite ? '★' : '☆'}
              </button>
              <button
                type="button"
                className="anno-tag-btn"
                aria-label={t('memory.storage.editTagsAria')}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditing({ ref: row.ref, meta: { label: row.title, toolId: row.toolId } })
                }}
              >
                #
              </button>
              {row.tags.length > 0 ? (
                <span className="anno-tags anno-tags--after-trigger">
                  {row.tags.slice(0, 3).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="anno-tag-chip"
                      title={tag}
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditing({ ref: row.ref, meta: { label: row.title, toolId: row.toolId } })
                      }}
                    >
                      {tag}
                    </button>
                  ))}
                  {row.tags.length > 3 ? (
                    <button
                      type="button"
                      className="anno-tag-chip"
                      title={row.tags.slice(3).join(' / ')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditing({ ref: row.ref, meta: { label: row.title, toolId: row.toolId } })
                      }}
                    >
                      +{row.tags.length - 3}
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className="session-item__meta">
              <span>{relativeTime(row.time)}</span>
              <span className="meta-sep">·</span>
              <span>{row.source === 'cli' ? t('memory.storage.sourceCli') : t('memory.storage.sourceAgent')}</span>
            </div>
          </div>
        </div>
      ))}

      <TagEditor
        open={editing !== null}
        targetRef={editing?.ref ?? null}
        meta={editing?.meta}
        title={editing?.ref.kind === 'message' ? t('memory.storage.editMessageTags') : t('memory.storage.editSessionTags')}
        onClose={() => { setEditing(null); reloadAnno() }}
      />
    </>
  )
}

// ─── 长期记忆 Vault（自动整理的确认记忆 / 用户画像） ────────────────────────────

type MemorySource = 'feishu' | 'session' | 'cli' | 'manual'
const SOURCE_ORDER: MemorySource[] = ['feishu', 'session', 'cli', 'manual']

/**
 * 记忆来源派生（不加 schema）：
 * - tags 含渠道平台（feishu 等）或 'channel' → 飞书
 * - 人工录入（evidence sourceType === 'manual'）→ 手动
 * - evidence sourceId 以 'agent:' 开头 → 会话（自建 agent 对话沉淀）
 * - 其余（toolId:nativeSessionId）→ CLI 历史
 */
function memorySourceOf(memory: DurableMemory): MemorySource {
  if (memory.tags.some((tag) => tag === 'channel' || tag === 'feishu' || tag === 'discord' || tag === 'wechat')) return 'feishu'
  if (memory.evidence.some((ev) => ev.sourceType === 'manual')) return 'manual'
  if (memory.evidence.some((ev) => ev.sourceId.startsWith('agent:'))) return 'session'
  return 'cli'
}

function memSourceLabel(src: MemorySource): string {
  switch (src) {
    case 'feishu':
      return tr('memory.storage.memSource.feishu')
    case 'session':
      return tr('memory.storage.memSource.session')
    case 'cli':
      return tr('memory.storage.memSource.cli')
    case 'manual':
      return tr('memory.storage.memSource.manual')
  }
}

function MemoryList({
  onOpenMemoryDetail,
  activeMemoryId,
  onOpenMemoryNew,
  onOpenPersona,
  personaActive
}: {
  onOpenMemoryDetail(rec: { id: string; title: string }): void
  activeMemoryId: string | null
  onOpenMemoryNew(): void
  onOpenPersona(): void
  personaActive: boolean
}): React.JSX.Element {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'memory' | 'persona'>('memory')
  const [entries, setEntries] = useState<DurableMemory[]>([])
  const [candidates, setCandidates] = useState<DurableMemory[]>([])
  const [showCandidates, setShowCandidates] = useState(false)
  const [persona, setPersona] = useState('')
  const [status, setStatus] = useState<MemoryIndexStatus | null>(null)

  const reload = (): void => {
    void window.agentOs.memory.listDurable({ statuses: ['active'] }).then(setEntries).catch(() => {})
    void window.agentOs.memory.listDurable({ statuses: ['candidate'] }).then(setCandidates).catch(() => {})
    void window.agentOs.memory.getPersona().then(setPersona).catch(() => {})
  }

  // 初次 + 详情切换（含新建/编辑后）时刷新列表，保证侧栏与内容页一致。
  useEffect(reload, [activeMemoryId])

  useEffect(() => {
    void window.agentOs.memory.indexStatus().then(setStatus).catch(() => {})
    const off = window.agentOs.events.onMemoryIndexProgress((s) => setStatus(s))
    return () => off()
  }, [])

  const resolveCandidate = (id: string, action: 'confirm' | 'reject'): void => {
    const op = action === 'confirm' ? window.agentOs.memory.confirm(id) : window.agentOs.memory.reject(id)
    void op.then(reload).catch(() => {})
  }

  const filtered = entries.filter(
    (entry) => entry.title.includes(query) || entry.content.includes(query) || entry.tags.some((tag) => tag.includes(query))
  )
  const groups = groupByMonth(filtered)

  // 单条记忆行：复用 session-item 规范（两行：标题 + meta），meta 用 muted 而非 accent，保持列表安静。
  const row = (memory: DurableMemory): React.JSX.Element => (
    <div
      key={memory.id}
      className={`session-item ${activeMemoryId === memory.id ? 'is-active' : ''}`}
      style={{ alignItems: 'flex-start' }}
      onClick={() => onOpenMemoryDetail({ id: memory.id, title: memory.title })}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="session-item__name">{memory.title}</div>
        <div className="session-item__meta">
          <span style={{ color: 'var(--text-secondary)' }}>{memory.kind}</span>
          <span className="meta-sep">·</span>
          <span>{memory.scope}</span>
          <span className="meta-sep">·</span>
          <span>{relativeTime(memory.createdAt)}</span>
        </div>
      </div>
    </div>
  )

  // 月组内按来源二级分组；仅该月仅有一个来源时折叠子标题，减少噪音。
  const renderMonth = (group: { key: string; label: string; items: DurableMemory[] }): React.JSX.Element => {
    const bySource = new Map<MemorySource, DurableMemory[]>()
    for (const item of group.items) {
      const src = memorySourceOf(item)
      const arr = bySource.get(src) ?? []
      arr.push(item)
      bySource.set(src, arr)
    }
    const sources = SOURCE_ORDER.filter((src) => bySource.has(src))
    const single = sources.length === 1
    return (
      <div key={group.key} style={{ marginBottom: 2 }}>
        <div className="mem-group">
          <span className="mem-group__label">{group.label}</span>
          <span className="mem-group__count">{group.items.length}</span>
        </div>
        {sources.map((src) => (
          <div key={src}>
            {!single && (
              <div className="mem-subgroup">
                <span className="mem-subgroup__label">{memSourceLabel(src)}</span>
                <span className="mem-subgroup__count">{bySource.get(src)!.length}</span>
              </div>
            )}
            {bySource.get(src)!.map((memory) => row(memory))}
          </div>
        ))}
      </div>
    )
  }

  const personaSummary = persona.trim() ? persona.trim().split('\n')[0].slice(0, 36) : t('memory.storage.personaSummaryEmpty')

  return (
    <>
      <div className="mode-seg" style={{ margin: '0 0 4px' }}>
        <button type="button" className={`mode-btn ${mode === 'memory' ? 'is-active' : ''}`} onClick={() => setMode('memory')}>{t('memory.storage.modeMemory')}</button>
        <button type="button" className={`mode-btn ${mode === 'persona' ? 'is-active' : ''}`} onClick={() => setMode('persona')}>{t('memory.storage.modePersona')}</button>
      </div>
      {mode === 'memory' && (
        <>
          <SearchBox value={query} onChange={setQuery} placeholder={t('memory.storage.searchMemoryPlaceholder')} />
          <div className="mem-status-row" style={{ padding: '0 0 2px' }}>
            <div className={`mem-status ${status?.building ? 'is-building' : ''}`}>
              <span className="mem-status__dot" />
              <span>
                {status?.building
                  ? t('memory.storage.indexing', { indexed: status.filesIndexed, total: status.filesTotal })
                  : t('memory.storage.memoryCount', { count: entries.length })}
              </span>
            </div>
            <button type="button" className="mem-add" onClick={onOpenMemoryNew} title={t('memory.storage.addMemoryAria')}>{t('memory.storage.addMemory')}</button>
          </div>
          {candidates.length > 0 && (
            <div className="mem-cands">
              <button type="button" className="mem-cands__head" onClick={() => setShowCandidates((v) => !v)}>
                <span className="mem-cands__badge">{candidates.length}</span>
                <span>{t('memory.storage.candidatesPending')}</span>
                <span className="mem-cands__chev">{showCandidates ? t('memory.storage.collapse') : t('memory.storage.expand')}</span>
              </button>
              {showCandidates && candidates.map((cand) => (
                <div key={cand.id} className="mem-cand-row">
                  <div className="mem-cand-row__body" onClick={() => onOpenMemoryDetail({ id: cand.id, title: cand.title })}>
                    <div className="session-item__name">{cand.title}</div>
                    <div className="session-item__meta">
                      <span style={{ color: 'var(--text-secondary)' }}>{cand.kind}</span>
                      <span className="meta-sep">·</span>
                      <span>{cand.scope}</span>
                    </div>
                  </div>
                  <button type="button" className="mem-act is-accent" onClick={() => resolveCandidate(cand.id, 'confirm')}>{t('common.action.confirm')}</button>
                  <button type="button" className="mem-act" onClick={() => resolveCandidate(cand.id, 'reject')}>{t('memory.storage.reject')}</button>
                </div>
              ))}
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="mem-empty">
              <div className="mem-empty__glyph">🧠</div>
              {query.trim() ? (
                <>
                  <div className="mem-empty__title">{t('memory.storage.noMemoryMatch')}</div>
                  <div className="mem-empty__desc">{t('memory.storage.noMemoryMatchHint')}</div>
                </>
              ) : (
                <>
                  <div className="mem-empty__title">{t('memory.storage.noMemory')}</div>
                  <div className="mem-empty__desc">{t('memory.storage.noMemoryHint')}</div>
                </>
              )}
            </div>
          ) : groups.map((group) => renderMonth(group))}
        </>
      )}
      {mode === 'persona' && (
        <div
          className={`session-item persona-nav-item ${personaActive ? 'is-active' : ''}`}
          onClick={onOpenPersona}
        >
          <span className="persona-glyph persona-glyph--sm" aria-hidden="true" />
          <div className="persona-nav-item__body">
            <div className="session-item__name">{t('memory.persona.title')}</div>
            <div className="session-item__meta persona-nav-item__meta">
              {personaSummary}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── 知识（Obsidian，延后） ───────────────────────────────────────────────────

function KnowledgePlaceholder(): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="mem-empty">
      <div className="mem-empty__glyph">📚</div>
      <div className="mem-empty__title">{t('memory.storage.knowledgeTitle')}</div>
      <div className="mem-empty__desc">{t('memory.storage.knowledgeDesc')}</div>
    </div>
  )
}

export function StorageSecPanel({
  subView,
  onSubView,
  onOpenRecord,
  activeRecordId,
  onOpenMemoryDetail,
  activeMemoryId,
  onOpenMemoryNew,
  onOpenPersona,
  personaActive
}: {
  subView: 'history' | 'memory' | 'knowledge'
  onSubView(v: 'history' | 'memory' | 'knowledge'): void
  onOpenRecord(rec: { id: string; title: string }): void
  activeRecordId: string | null
  onOpenMemoryDetail(rec: { id: string; title: string }): void
  activeMemoryId: string | null
  onOpenMemoryNew(): void
  onOpenPersona(): void
  personaActive: boolean
}): React.JSX.Element {
  const { t } = useT()
  return (
    <>
      <div style={{ padding: '7px 7px 4px' }}>
        <div className="mode-seg">
          {([{ k: 'history', l: t('memory.storage.navSession') }, { k: 'memory', l: t('memory.storage.navMemory') }, { k: 'knowledge', l: t('memory.storage.navKnowledge') }] as const).map((m) => (
            <button key={m.k} className={`mode-btn ${subView === m.k ? 'is-active' : ''}`} onClick={() => onSubView(m.k)}>
              {m.l}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-divider" style={{ margin: '0 7px' }} />
      <div className="sec-scroll">
        {subView === 'history' && <HistoryList onOpenRecord={onOpenRecord} activeRecordId={activeRecordId} />}
        {subView === 'memory' && (
          <MemoryList
            onOpenMemoryDetail={onOpenMemoryDetail}
            activeMemoryId={activeMemoryId}
            onOpenMemoryNew={onOpenMemoryNew}
            onOpenPersona={onOpenPersona}
            personaActive={personaActive}
          />
        )}
        {subView === 'knowledge' && <KnowledgePlaceholder />}
      </div>
    </>
  )
}
