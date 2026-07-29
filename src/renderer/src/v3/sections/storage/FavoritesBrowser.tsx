// 收藏 / 标签 浏览页（SPEC-025）。集中查看「收藏 + 打标签」的会话与消息。
// 数据源：annotations.listAnnotated（CLI 会话收藏、所有标签、消息级收藏/标签）
// 合并 sessionsStore 里 managed 会话的 Conversation.favorite（SPEC-020 真源，不在标注层）。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AnnotationBrowseEntry,
  AnnotationDisplayMeta,
  AnnotationTargetRef
} from '@shared/types'
import { annotationTargetKey } from '@shared/types'
import { useSessionsStore } from '../../../stores/sessionsStore'
import { useAnnotationsStore } from '../../../stores/annotationsStore'
import { ToolIcon } from '../../../lib/toolIcons'
import { TagEditor } from './TagEditor'
import { useT } from '../../../lib/i18n'
import { tr, localeFor } from '@shared/i18n'
import { getCurrentRendererLang } from '../../../lib/i18n'
import { sessionDisplayTitle } from '../../../lib/sessionTitle'

function relativeTime(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const min = Math.floor((Date.now() - then) / 60000)
  if (min < 1) return tr('memory.time.justNow')
  if (min < 60) return tr('memory.time.minutesAgo', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return tr('memory.time.hoursAbbr', { count: hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return tr('memory.time.daysAgo', { count: day })
  return new Date(iso).toLocaleDateString(localeFor(getCurrentRendererLang()))
}

// 标注目标 → 打开记录所用的 id（会话本身，或消息所属会话）。
function navIdOf(ref: AnnotationTargetRef): string {
  if (ref.kind === 'conversation') {
    return ref.source === 'managed' ? ref.convId : `${ref.toolId}:${ref.nativeSessionId}`
  }
  return ref.source === 'managed' ? ref.sessionId : `${ref.toolId}:${ref.nativeSessionId}`
}

interface BrowseRow {
  key: string
  ref: AnnotationTargetRef
  kind: 'conversation' | 'message'
  source: 'managed' | 'cli'
  favorite: boolean
  tags: string[]
  label: string
  toolId: string
  updatedAt: string
  navId: string
}

function rowFromEntry(entry: AnnotationBrowseEntry): BrowseRow {
  return {
    key: annotationTargetKey(entry.ref),
    ref: entry.ref,
    kind: entry.ref.kind,
    source: entry.ref.source,
    favorite: entry.favorite,
    tags: entry.tags,
    label: entry.label,
    toolId: entry.toolId,
    updatedAt: entry.updatedAt,
    navId: navIdOf(entry.ref)
  }
}

export function FavoritesBrowser({
  onOpenRecord,
  activeRecordId
}: {
  onOpenRecord(rec: { id: string; title: string }): void
  activeRecordId: string | null
}): React.JSX.Element {
  const { t } = useT()
  const views = useSessionsStore((s) => s.views)
  const toggleViewFavorite = useSessionsStore((s) => s.toggleFavorite)
  const toggleAnnoFavorite = useAnnotationsStore((s) => s.toggleFavorite)
  const tagCounts = useAnnotationsStore((s) => s.tagCounts)
  const refreshTags = useAnnotationsStore((s) => s.refreshTags)
  const listAnnotated = useAnnotationsStore((s) => s.listAnnotated)

  const [annoRows, setAnnoRows] = useState<BrowseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ ref: AnnotationTargetRef; meta: AnnotationDisplayMeta } | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    void listAnnotated()
      .then((entries) => setAnnoRows(entries.map(rowFromEntry)))
      .catch(() => setAnnoRows([]))
      .finally(() => setLoading(false))
  }, [listAnnotated])

  useEffect(() => {
    void refreshTags()
    reload()
  }, [refreshTags, reload])

  // 合并 managed 会话收藏（不在标注层）。
  const rows = useMemo(() => {
    const byKey = new Map(annoRows.map((r) => [r.key, r]))
    for (const v of views) {
      if (!v.favorite) continue
      const ref: AnnotationTargetRef = { kind: 'conversation', source: 'managed', convId: v.id }
      const key = annotationTargetKey(ref)
      const existing = byKey.get(key)
      byKey.set(key, {
        key,
        ref,
        kind: 'conversation',
        source: 'managed',
        favorite: true,
        tags: existing?.tags ?? [],
        label: existing?.label || sessionDisplayTitle(v),
        toolId: existing?.toolId || v.toolId,
        updatedAt: existing?.updatedAt || v.lastActivityAt || '',
        navId: v.id
      })
    }
    let list = [...byKey.values()]
    if (favoriteOnly) list = list.filter((r) => r.favorite)
    if (selectedTag) {
      const lower = selectedTag.toLowerCase()
      list = list.filter((r) => r.tags.some((t) => t.toLowerCase() === lower))
    }
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }, [annoRows, views, favoriteOnly, selectedTag])

  const toggleFavorite = (row: BrowseRow): void => {
    if (row.kind === 'conversation' && row.source === 'managed') {
      void toggleViewFavorite(row.navId, !row.favorite)
    } else {
      void toggleAnnoFavorite(row.ref, !row.favorite, { label: row.label, toolId: row.toolId }).then(reload)
    }
  }

  return (
    <>
      <div className="fav-filter">
        <button
          type="button"
          className={`anno-tag-chip ${favoriteOnly ? 'is-active' : ''}`}
          onClick={() => setFavoriteOnly((v) => !v)}
        >
          {t('memory.fav.favoriteOnly')}
        </button>
        {tagCounts.map((c) => (
          <button
            key={c.tag}
            type="button"
            className={`anno-tag-chip ${selectedTag?.toLowerCase() === c.tag.toLowerCase() ? 'is-active' : ''}`}
            onClick={() => setSelectedTag(selectedTag?.toLowerCase() === c.tag.toLowerCase() ? null : c.tag)}
            title={`${c.tag} (${c.count})`}
          >
            {c.tag} · {c.count}
          </button>
        ))}
      </div>

      {rows.length === 0 && (
        <div style={{ padding: '14px 9px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          {loading ? t('common.state.loading') : t('memory.fav.empty')}
        </div>
      )}

      {rows.map((row) => (
        <div
          key={row.key}
          className={`session-item ${activeRecordId === row.navId ? 'is-active' : ''}`}
          onClick={() => onOpenRecord({ id: row.navId, title: row.label || t('memory.fav.untitled') })}
        >
          <ToolIcon toolId={row.toolId} size={16} brandColor />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div className="session-item__name" style={{ flex: 1, minWidth: 0 }}>
                {row.kind === 'message' ? <span className="anno-kind-badge">{t('memory.fav.messageKind')}</span> : null}
                {row.label || t('memory.fav.untitled')}
              </div>
              <button
                type="button"
                className={`anno-star ${row.favorite ? 'is-active' : ''}`}
                aria-label={row.favorite ? t('memory.fav.unstarAria') : t('memory.fav.starAria')}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFavorite(row)
                }}
              >
                {row.favorite ? '★' : '☆'}
              </button>
              <button
                type="button"
                className="anno-tag-btn"
                aria-label={t('memory.fav.editTagsAria')}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditing({ ref: row.ref, meta: { label: row.label, toolId: row.toolId } })
                }}
              >
                #
              </button>
              {row.tags.length > 0 ? (
                <span className="anno-tags anno-tags--after-trigger">
                  {row.tags.slice(0, 4).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="anno-tag-chip"
                      title={tag}
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditing({ ref: row.ref, meta: { label: row.label, toolId: row.toolId } })
                      }}
                    >
                      {tag}
                    </button>
                  ))}
                  {row.tags.length > 4 ? (
                    <button
                      type="button"
                      className="anno-tag-chip"
                      title={row.tags.slice(4).join(' / ')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditing({ ref: row.ref, meta: { label: row.label, toolId: row.toolId } })
                      }}
                    >
                      +{row.tags.length - 4}
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className="session-item__meta">
              <span>{relativeTime(row.updatedAt)}</span>
            </div>
          </div>
        </div>
      ))}

      <TagEditor
        open={editing !== null}
        targetRef={editing?.ref ?? null}
        meta={editing?.meta}
        title={editing?.ref.kind === 'message' ? t('memory.fav.editMessageTags') : t('memory.fav.editSessionTags')}
        onClose={() => {
          setEditing(null)
          reload()
        }}
      />
    </>
  )
}
