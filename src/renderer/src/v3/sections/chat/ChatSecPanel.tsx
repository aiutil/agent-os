// 会话镜头二级面板（接 sessionsStore）。
// 会话/CLI 模式切换 + 新建（CLI 走弹窗快速启动）+ 按项目分组（首组展开、其余折叠、可滚动）
// + 固定在底部的活动热力。

import { useEffect, useState } from 'react'
import { useSessionsStore } from '../../../stores/sessionsStore'
import { useUiStore } from '../../../stores/uiStore'
import type { RemoteNodeStatus, WorkbenchSessionView } from '@shared/types'
import {
  remoteNodeTipLabel,
  remoteRuntimeHostId,
  sessionProjectGroupKey
} from '@shared/session-origin'
import { ToolIcon } from '../../../lib/toolIcons'
import { sessionDisplayTitle } from '../../../lib/sessionTitle'
import { ActivityHeat } from './ActivityHeat'
import { CliLaunchDialog } from './CliLaunchDialog'
import { useT } from '../../../lib/i18n'
import { relativeTime } from '../../../lib/time'

const IcChat = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 4.5h12M2 8h9M2 11.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
const IcCLI = (): React.JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
    <rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
    <path d="M3.5 4.5l2 2-2 2M7 8.5h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const IcFolder = (): React.JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <path d="M1 4.5C1 3.7 1.6 3 2.4 3h2l1 1.3h4.2c.8 0 1.4.6 1.4 1.4V9c0 .8-.6 1.4-1.4 1.4H2.4C1.6 10.4 1 9.8 1 9V4.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
)
const IcPin = (): React.JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
    <path
      d="M9.6 1.9 13.1 5.4 10.9 7.6 11.1 10.7 10.3 11.5 7.8 9 4.4 12.4 3.7 11.7 7.1 8.3 4.6 5.8 5.4 5 8.5 5.2 9.6 1.9Z"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
const IcArchive = (): React.JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
    <path
      d="M2.4 4.9h10.2M3.3 4.9v6.5c0 .8.6 1.4 1.4 1.4h5.6c.8 0 1.4-.6 1.4-1.4V4.9M2.8 2.4h9.4l.4 2.5H2.4l.4-2.5ZM6.2 7.3h2.6"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const IcRename = (): React.JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
    <path
      d="M10.2 2.4l2.4 2.4L5.4 12l-2.6.6.5-2.6 6.9-6.9z"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

function basename(path: string, home: string): string {
  if (!path) return `~ ${home}`
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

export function sessionListTitle(view: WorkbenchSessionView): string {
  return sessionDisplayTitle(view)
}

export function ChatSecPanel({
  onNew,
  onOpenSession,
  onArchiveSession,
  onTogglePinned
}: {
  onNew(): void
  onOpenSession(view: WorkbenchSessionView): void
  onArchiveSession(view: WorkbenchSessionView): void
  onTogglePinned(view: WorkbenchSessionView, pinned: boolean): void
}): React.JSX.Element {
  const views = useSessionsStore((s) => s.views)
  const selectedId = useSessionsStore((s) => s.selectedId)
  const mode = useUiStore((s) => s.workbenchMode)
  const setMode = useUiStore((s) => s.setWorkbenchMode)
  const { t, lang } = useT()
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [cliDialog, setCliDialog] = useState(false)
  const [query, setQuery] = useState('')
  const rename = useSessionsStore((s) => s.rename)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [remoteStatuses, setRemoteStatuses] = useState<RemoteNodeStatus[]>([])

  useEffect(() => {
    void window.agentOs.runtime.remoteNodeStatuses().then(setRemoteStatuses).catch(() => {})
    return window.agentOs.events.onRemoteNodeStateChanged((status) => {
      setRemoteStatuses((current) => [
        ...current.filter((candidate) => candidate.id !== status.id),
        status
      ])
    })
  }, [])

  const startRename = (view: WorkbenchSessionView): void => {
    setEditingId(view.id)
    setEditName(sessionListTitle(view))
  }
  const commitRename = async (view: WorkbenchSessionView): Promise<void> => {
    const id = view.id
    const next = editName
    setEditingId(null)
    await rename(id, next)
  }
  const cancelRename = (): void => setEditingId(null)

  const q = query.trim().toLowerCase()
  const list = views
    .filter((v) => (mode === 'cli' ? v.surface === 'terminal' : v.surface === 'chat'))
    .filter(
      (v) =>
        q === '' ||
        sessionListTitle(v).toLowerCase().includes(q) ||
        v.name.toLowerCase().includes(q) ||
        (v.workspacePath ?? '').toLowerCase().includes(q)
    )
    .sort((a, b) => {
      const pinDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      if (pinDelta !== 0) return pinDelta
      const timeDelta = (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
      if (timeDelta !== 0) return timeDelta
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    })

  const groups: Array<{
    id: string
    path: string
    runtimeHostId?: string
    items: WorkbenchSessionView[]
  }> = []
  for (const v of list) {
    const path = v.workspacePath || ''
    const runtimeHostId = remoteRuntimeHostId(v.runtimeHostId)
    const id = sessionProjectGroupKey(path, runtimeHostId)
    let g = groups.find((candidate) => candidate.id === id)
    if (!g) {
      g = { id, path, ...(runtimeHostId ? { runtimeHostId } : {}), items: [] }
      groups.push(g)
    }
    g.items.push(v)
  }

  // 默认首组展开、其余折叠；用户手动切换后以记录为准。搜索时全部展开以暴露所有命中。
  const isOpen = (groupId: string, index: number): boolean =>
    q !== '' ? true : (openGroups[groupId] ?? index === 0)
  const toggle = (groupId: string, index: number): void =>
    setOpenGroups((prev) => ({
      ...prev,
      [groupId]: !(prev[groupId] ?? index === 0)
    }))

  return (
    <>
      <div style={{ padding: '7px 7px 4px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="mode-seg">
          {([{ k: 'chat', ic: <IcChat />, l: t('chat.mode.chat') }, { k: 'cli', ic: <IcCLI />, l: t('chat.mode.cli') }] as const).map((m) => (
            <button
              key={m.k}
              className={`mode-btn ${mode === m.k ? 'is-active' : ''}`}
              onClick={() => setMode(m.k)}
            >
              {m.ic}
              <span>{m.l}</span>
            </button>
          ))}
        </div>
        <button className="panel-new" onClick={() => (mode === 'cli' ? setCliDialog(true) : onNew())}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>＋</span>
          {mode === 'cli' ? t('chat.action.newCli') : t('chat.action.newChat')}
          <span className="panel-new__kbd">⌘N</span>
        </button>
        <div className="chat-search">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8.9 8.9L12 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === 'cli' ? t('chat.search.placeholderCli') : t('chat.search.placeholderChat')}
            aria-label={t('chat.search.aria')}
          />
        </div>
      </div>
      <div className="panel-divider" style={{ margin: '0 7px' }} />
      <div className="sec-scroll">
        {groups.length === 0 && (
          <div style={{ padding: '12px 9px', fontSize: 11.5, color: 'var(--text-muted)' }}>
            {q !== ''
              ? (mode === 'cli' ? t('chat.empty.noMatchCli', { query: query.trim() }) : t('chat.empty.noMatchChat', { query: query.trim() }))
              : (mode === 'cli' ? t('chat.empty.hintCli') : t('chat.empty.hintChat'))}
          </div>
        )}
        {groups.map((g, index) => {
          const open = isOpen(g.id, index)
          const nodeLabel = remoteNodeTipLabel(
            g.runtimeHostId,
            remoteStatuses,
            t('chat.node.remoteNode')
          )
          return (
            <div key={g.id}>
              <button className="chat-folder" onClick={() => toggle(g.id, index)}>
                <span className="chat-folder__icon">
                  <IcFolder />
                </span>
                <span className="chat-folder__name">
                  {g.path ? basename(g.path, t('chat.folder.home')) : t('chat.folder.home')}
                </span>
                {nodeLabel ? (
                  <span
                    className="chat-folder__node-tip"
                    title={`${t('chat.node.remoteNode')}：${nodeLabel}`}
                  >
                    {nodeLabel}
                  </span>
                ) : null}
                <span className={`chat-folder__chevron ${open ? 'is-open' : ''}`}>
                  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                    <path d="M2.5 1.5l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="chat-folder__count">{g.items.length}</span>
              </button>
              {open &&
                g.items.map((v) => {
                  const pinned = Boolean(v.pinned)
                  return (
                    <div
                      key={v.id}
                      className={`session-item chat-session-item ${selectedId === v.id ? 'is-active' : ''} ${pinned ? 'is-pinned' : ''}`}
                      onClick={() => {
                        // 编辑中不触发打开（input/按钮已各自 stopPropagation，兜底点击行内空白）
                        if (editingId !== v.id) onOpenSession(v)
                      }}
                    >
                      <ToolIcon toolId={v.toolId} size={13} brandColor className="chat-session-item__tool" />
                      <div className="chat-session-item__body">
                        <div className="chat-session-item__headline">
                          {editingId === v.id ? (
                            <input
                              // SPEC-035：行内改名。保存时 nameProvisional:false 锁定，5 处自动改名不再覆盖。
                              value={editName}
                              onChange={(event) => setEditName(event.target.value)}
                              onClick={(event) => event.stopPropagation()}
                              onDoubleClick={(event) => event.stopPropagation()}
                              onBlur={() => void commitRename(v)}
                              onKeyDown={(event) => {
                                event.stopPropagation()
                                if (event.key === 'Enter') void commitRename(v)
                                if (event.key === 'Escape') cancelRename()
                              }}
                              autoFocus
                              onFocus={(event) => event.currentTarget.select()}
                              aria-label={t('common.action.rename')}
                              className="chat-session-item__title-input"
                            />
                          ) : (
                            <div
                              className="chat-session-item__title"
                              title={t('common.action.rename')}
                              onDoubleClick={(event) => {
                                event.stopPropagation()
                                startRename(v)
                              }}
                            >
                              {sessionListTitle(v)}
                            </div>
                          )}
                          <div className="chat-session-item__time">{relativeTime(v.lastActivityAt ?? '', lang)}</div>
                        </div>
                        <div className="chat-session-item__subline">
                          {v.surface === 'chat' ? t('chat.session.surfaceChat') : t('chat.session.surfaceCli')} · {v.source === 'channel' ? t('chat.session.sourceChannel') : t('chat.session.sourceDesktop')} · {v.workspacePath || '~'}
                        </div>
                      </div>
                      <div className="chat-session-item__actions">
                        <button
                          type="button"
                          className="chat-session-item__action"
                          aria-label={t('common.action.rename')}
                          title={t('common.action.rename')}
                          onClick={(event) => {
                            event.stopPropagation()
                            startRename(v)
                          }}
                        >
                          <IcRename />
                        </button>
                        <button
                          type="button"
                          className={`chat-session-item__action ${pinned ? 'is-active' : ''}`}
                          aria-label={pinned ? t('chat.session.unpin') : t('chat.session.pin')}
                          title={pinned ? t('chat.session.unpin') : t('chat.session.pin')}
                          onClick={(event) => {
                            event.stopPropagation()
                            onTogglePinned(v, !pinned)
                          }}
                        >
                          <IcPin />
                        </button>
                        <button
                          type="button"
                          className="chat-session-item__action"
                          aria-label={t('chat.session.archive')}
                          title={t('chat.session.archive')}
                          onClick={(event) => {
                            event.stopPropagation()
                            onArchiveSession(v)
                          }}
                        >
                          <IcArchive />
                        </button>
                      </div>
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
      <ActivityHeat />
      {cliDialog && (
        <CliLaunchDialog
          onClose={() => setCliDialog(false)}
          onOpenSession={(view) => onOpenSession(view)}
        />
      )}
    </>
  )
}
