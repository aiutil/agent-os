// 会话列表（SPEC-005）。嵌入应用唯一侧栏，不形成第二级导航。
// SPEC-020：只保留「全部 / 收藏」，状态用于排序与展示。

import { useEffect, useMemo, useState } from 'react'
import { useSessionsStore } from '../../stores/sessionsStore'
import { useUiStore } from '../../stores/uiStore'
import { useAnnotationsStore } from '../../stores/annotationsStore'
import { useT } from '../../lib/i18n'
import { annotationTargetKey } from '@shared/types'
import type { AnnotationTargetRef, RemoteNodeStatus, WorkbenchSessionView } from '@shared/types'
import {
  remoteNodeTipLabel,
  remoteRuntimeHostId,
  sessionProjectGroupKey
} from '@shared/session-origin'
import { SessionCard } from './SessionCard'
import { sessionDisplayTitle } from '../../lib/sessionTitle'

type FilterKey = 'all' | 'favorite'

const FILTERS: Array<{ key: FilterKey }> = [{ key: 'all' }, { key: 'favorite' }]

const ACTIVE_STATUSES = new Set(['starting', 'running', 'waiting_input'])

function matchesFilter(view: WorkbenchSessionView, filter: FilterKey): boolean {
  switch (filter) {
    case 'favorite':
      return view.favorite
    case 'all':
    default:
      return true
  }
}

function projectNameOf(workspacePath: string): string {
  const parts = workspacePath.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || workspacePath || ''
}

export function SessionRail(): React.JSX.Element {
  const views = useSessionsStore((s) => s.views)
  const select = useSessionsStore((s) => s.select)
  const selectProject = useSessionsStore((s) => s.selectProject)
  const selectedProjectPath = useSessionsStore((s) => s.selectedProjectPath)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [remoteStatuses, setRemoteStatuses] = useState<RemoteNodeStatus[]>([])
  const mode = useUiStore((s) => s.workbenchMode)
  const surfaceForMode = mode === 'cli' ? 'terminal' : 'chat'
  const { t } = useT()

  useEffect(() => {
    void window.agentOs.runtime
      .remoteNodeStatuses()
      .then(setRemoteStatuses)
      .catch(() => {})
    return window.agentOs.events.onRemoteNodeStateChanged((status) => {
      setRemoteStatuses((current) => [
        ...current.filter((candidate) => candidate.id !== status.id),
        status
      ])
    })
  }, [])

  const tagCounts = useAnnotationsStore((s) => s.tagCounts)
  const refreshTags = useAnnotationsStore((s) => s.refreshTags)
  const entries = useAnnotationsStore((s) => s.entries)
  const loadMany = useAnnotationsStore((s) => s.loadMany)

  const modeViews = useMemo(
    () => views.filter((view) => view.surface === surfaceForMode),
    [views, surfaceForMode]
  )

  // 拉取当前模式会话的会话级标注（用于按标签筛选）。会话切换后重选。
  const sessionRefs = useMemo<AnnotationTargetRef[]>(
    () => modeViews.map((v) => ({ kind: 'conversation', source: 'managed', convId: v.id })),
    [modeViews]
  )
  useEffect(() => {
    void refreshTags()
    void loadMany(sessionRefs)
  }, [sessionRefs, refreshTags, loadMany])

  const tagsByConv = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const v of modeViews) {
      const ref = { kind: 'conversation' as const, source: 'managed' as const, convId: v.id }
      const anno = entries.get(annotationTargetKey(ref))
      if (anno && anno.tags.length > 0)
        map.set(v.id, new Set(anno.tags.map((t) => t.toLowerCase())))
    }
    return map
  }, [modeViews, entries])
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = modeViews.filter(
      (view) =>
        matchesFilter(view, filter) &&
        (selectedTag === null || tagsByConv.get(view.id)?.has(selectedTag.toLowerCase())) &&
        (q === '' ||
          sessionDisplayTitle(view).toLowerCase().includes(q) ||
          view.name.toLowerCase().includes(q) ||
          view.workspacePath.toLowerCase().includes(q))
    )
    const map = new Map<
      string,
      { workspacePath: string; runtimeHostId?: string; sessions: WorkbenchSessionView[] }
    >()
    for (const view of filtered) {
      const runtimeHostId = remoteRuntimeHostId(view.runtimeHostId)
      const key = sessionProjectGroupKey(view.workspacePath, runtimeHostId)
      const group = map.get(key) ?? {
        workspacePath: view.workspacePath,
        ...(runtimeHostId ? { runtimeHostId } : {}),
        sessions: []
      }
      group.sessions.push(view)
      map.set(key, group)
    }
    return Array.from(map.values())
      .map((group) => ({
        ...group,
        projectName: projectNameOf(group.workspacePath),
        sessions: group.sessions.sort((a, b) => {
          const activeDelta =
            Number(ACTIVE_STATUSES.has(b.status)) - Number(ACTIVE_STATUSES.has(a.status))
          return activeDelta || b.lastActivityAt.localeCompare(a.lastActivityAt)
        })
      }))
      .sort((a, b) => {
        const aLatest = a.sessions[0]?.lastActivityAt ?? ''
        const bLatest = b.sessions[0]?.lastActivityAt ?? ''
        return bLatest.localeCompare(aLatest)
      })
  }, [modeViews, filter, query, selectedTag, tagsByConv])

  return (
    <section className="rail" aria-label={t('workbench.rail.aria')}>
      <div className="rail__section-head">
        <span>
          {mode === 'cli'
            ? t('workbench.rail.sectionTerminal')
            : t('workbench.rail.sectionSession')}
        </span>
        <span className="rail__section-count">{modeViews.length}</span>
      </div>

      <div className="rail__tabs">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`rail__tab ${filter === item.key ? 'is-active' : ''}`}
            onClick={() => setFilter(item.key)}
          >
            {item.key === 'all'
              ? t('workbench.rail.filter.all')
              : t('workbench.rail.filter.favorite')}
          </button>
        ))}
      </div>

      <input
        className="rail__search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('workbench.rail.filterSessions')}
        aria-label={t('workbench.rail.filterSessions')}
      />

      {tagCounts.length > 0 ? (
        <div
          className="rail__tag-row"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0 8px 6px' }}
        >
          {tagCounts.slice(0, 10).map((c) => (
            <button
              key={c.tag}
              type="button"
              className={`anno-tag-chip ${selectedTag?.toLowerCase() === c.tag.toLowerCase() ? 'is-active' : ''}`}
              onClick={() =>
                setSelectedTag(selectedTag?.toLowerCase() === c.tag.toLowerCase() ? null : c.tag)
              }
              title={`${c.tag} (${c.count})`}
            >
              {c.tag} · {c.count}
            </button>
          ))}
          {selectedTag !== null ? (
            <button
              type="button"
              className="anno-tag-chip"
              onClick={() => setSelectedTag(null)}
              title={t('workbench.rail.clearTagFilter')}
            >
              {t('workbench.rail.clear')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="rail__list">
        {groups.length === 0 ? (
          <div className="rail__empty">
            <p>
              {mode === 'cli'
                ? t('workbench.rail.emptyTerminal')
                : t('workbench.rail.emptySession')}
            </p>
            <button type="button" className="btn btn--ghost" onClick={() => select(null)}>
              + {mode === 'cli' ? t('workbench.rail.openTerminal') : t('workbench.rail.newSession')}
            </button>
          </div>
        ) : (
          groups.map((group) => {
            const nodeLabel = remoteNodeTipLabel(
              group.runtimeHostId,
              remoteStatuses,
              t('chat.node.remoteNode')
            )
            return (
              <div
                key={`${group.runtimeHostId ?? 'local'}:${group.workspacePath}`}
                className="rail__group"
              >
                <button
                  type="button"
                  className={`rail__group-head ${
                    selectedProjectPath === group.workspacePath ? 'is-selected' : ''
                  }`}
                  onClick={() => selectProject(group.workspacePath)}
                  title={t('workbench.rail.selectAsWorkdir')}
                >
                  <span className="rail__group-title">
                    <span className="rail__group-name">
                      {group.projectName || t('workbench.rail.unnamedProject')}
                    </span>
                    {nodeLabel ? (
                      <span
                        className="rail__group-node-tip"
                        title={`${t('chat.node.remoteNode')}：${nodeLabel}`}
                      >
                        {nodeLabel}
                      </span>
                    ) : null}
                  </span>
                  <span className="rail__group-path mono">{group.workspacePath}</span>
                </button>
                {group.sessions.map((view) => (
                  <SessionCard key={view.id} view={view} />
                ))}
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
