// 全局搜索 Modal（⌘K）。按标题/路径/工具/内容过滤，结果按类型分组展示。

import { useEffect, useRef, useState } from 'react'
import './SearchModal.css'
import { useUiStore } from '../stores/uiStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { openWorkspaceTab } from '../workspace-tabs/navigation'
import { useDialogFocus, useScrollLock } from '../lib/ui'
import { sessionStatusColor, sessionStatusLabel } from '../lib/status'
import { relativeTime } from '../lib/time'
import { useT } from '../lib/i18n'
import { ToolIcon } from '../lib/toolIcons'
import type { KnowledgeArticle, MemorySearchHit, WorkbenchSessionView } from '@shared/types'
import type { MemoryIndexStatus } from '@shared/types'
import { sanitizeTranscriptTitle } from '@shared/transcript/title'
import { sessionDisplayTitle } from '../lib/sessionTitle'

function basename(path: string): string {
  if (!path) return '~'
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

export function SearchModal(): React.JSX.Element {
  const close = useUiStore((s) => s.closeSearchModal)
  const views = useSessionsStore((s) => s.views)
  const { t } = useT()

  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'all' | 'chat' | 'cli' | 'knowledge'>('all')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [knowledgeHits, setKnowledgeHits] = useState<KnowledgeArticle[]>([])
  const [searching, setSearching] = useState(false)
  const [indexStatus, setIndexStatus] = useState<MemoryIndexStatus | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 焦点契约：打开聚焦输入框、Tab 循环、ESC 关闭、锁定背景滚动。
  useDialogFocus(boxRef, true, { onEscape: close })
  useScrollLock(true)

  const q = query.trim().toLowerCase()

  const filtered = q
    ? views.filter(
        (v) =>
          sessionDisplayTitle(v).toLowerCase().includes(q) ||
          v.name.toLowerCase().includes(q) ||
          v.workspacePath.toLowerCase().includes(q) ||
          v.toolId.toLowerCase().includes(q)
      )
    : views

  const chatViews = filtered.filter((v) => v.surface === 'chat')
  const cliViews = filtered.filter((v) => v.surface === 'terminal')

  // 内容搜索（防抖 400ms，至少 2 字符触发）
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (!q || q.length < 2) {
      setHits([])
      setKnowledgeHits([])
      return
    }
    searchTimer.current = setTimeout(() => {
      setSearching(true)
      void window.agentOs.session
        .search({ query: q, limit: 16 })
        .then((results) => setHits(results))
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
      void window.agentOs.knowledge
        .list({ query: q, statuses: ['published'], limit: 16 })
        .then((results) => setKnowledgeHits(results))
        .catch(() => setKnowledgeHits([]))
    }, 400)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [q])

  useEffect(() => {
    void window.agentOs.memory.indexStatus().then(setIndexStatus).catch(() => {})
    const off = window.agentOs.events.onMemoryIndexProgress((status) => setIndexStatus(status))
    return () => off()
  }, [])

  // 与 V3App 的开标签方式保持一致：走 workspace-tab 导航 helper，同步 active page 与关联 store。
  // highlight：从搜索跳转时携带搜索词，目标视图据此在内容里高亮并滚到首个匹配。
  const openSessionTab = (view: WorkbenchSessionView, highlight?: string): void => {
    openWorkspaceTab({
      kind: 'session',
      resourceId: view.id,
      title: sessionDisplayTitle(view),
      toolId: view.toolId,
      highlight
    })
  }
  const openRecordTab = (resourceId: string, title: string, toolId: string, highlight?: string): void => {
    openWorkspaceTab({ kind: 'memory', resourceId, title, toolId, highlight })
  }

  const term = query.trim()

  const handleSelectSession = (id: string): void => {
    const view = views.find((item) => item.id === id)
    if (!view) return
    // 标题/路径命中也带上搜索词，跳转后若正文含该词同样高亮。
    openSessionTab(view, term)
    close()
  }

  const handleSelectHit = (hit: MemorySearchHit): void => {
    // 自建对话 hit.sessionId === 会话 id；CLI 历史按 toolId+nativeSessionId 回连实时 view。
    const view =
      views.find((v) => v.id === hit.sessionId) ??
      views.find((v) => v.toolId === hit.toolId && v.nativeSessionId === hit.nativeSessionId)
    if (view) openSessionTab(view, term)
    // 无实时会话（多为 CLI 历史）：打开只读回放。
    else openRecordTab(hit.sessionId, sanitizeTranscriptTitle(hit.title) || hit.title || hit.nativeSessionId, hit.toolId, term)
    close()
  }

  const handleSelectKnowledge = (article: KnowledgeArticle): void => {
    window.dispatchEvent(new CustomEvent('agent-os:open-knowledge', { detail: article.id }))
    close()
  }

  const showChat = tab === 'all' || tab === 'chat'
  const showCli = tab === 'all' || tab === 'cli'
  const showKnowledge = tab === 'all' || tab === 'knowledge'
  // 内容命中：剔除已作为实时会话条目展示的，再按来源归入当前 tab。
  const shownViewIds = new Set(filtered.map((v) => v.id))
  const matchesView = (hit: MemorySearchHit): boolean =>
    shownViewIds.has(hit.sessionId) ||
    filtered.some((v) => v.toolId === hit.toolId && v.nativeSessionId === hit.nativeSessionId)
  const agentHits = hits.filter((h) => h.source === 'agent' && !matchesView(h))
  const cliHits = hits.filter((h) => h.source !== 'agent' && !matchesView(h))
  const visibleHits = tab === 'chat' ? agentHits : tab === 'cli' ? cliHits : tab === 'all' ? [...agentHits, ...cliHits] : []
  const allEmpty = filtered.length === 0 && hits.length === 0 && knowledgeHits.length === 0

  return (
    <div className="search-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div
        ref={boxRef}
        className="search-modal-box"
        role="dialog"
        aria-modal="true"
        aria-label={t('common.action.search')}
      >
        <div className="search-input-wrap">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            className="search-input"
            aria-label={t('common.action.search')}
            placeholder={t('channels.search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{t('channels.search.searching')}</span>}
          {indexStatus?.building || indexStatus?.optimizing ? (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{t('channels.search.supplementing')}</span>
          ) : null}
          <button type="button" className="search-esc-btn" onClick={close}>ESC</button>
        </div>

        <div className="search-tabs">
          {(['all', 'chat', 'cli', 'knowledge'] as const).map((tk) => (
            <button
              key={tk}
              type="button"
              className={`search-tab ${tab === tk ? 'is-active' : ''}`}
              onClick={() => setTab(tk)}
            >
              {tk === 'all' ? t('common.label.all') : tk === 'chat' ? `${t('channels.search.tabChat')}${chatViews.length > 0 ? ` ${chatViews.length}` : ''}` : tk === 'cli' ? `${t('channels.search.tabCli')}${cliViews.length > 0 ? ` ${cliViews.length}` : ''}` : `${t('memory.atlas.common.library')}${knowledgeHits.length > 0 ? ` ${knowledgeHits.length}` : ''}`}
            </button>
          ))}
        </div>

        <div className="search-results">
          {allEmpty && !searching && (
            <div className="search-empty" role="status">{q ? t('channels.search.noMatch') : t('channels.search.noSessions')}</div>
          )}

          {showChat && chatViews.length > 0 && (
            <>
              <div className="search-group-label">{t('channels.search.groupChat')}</div>
              {chatViews.map((v) => (
                <button key={v.id} type="button" className="search-item" onClick={() => handleSelectSession(v.id)}>
                  <span className="search-item__dot" style={{ background: sessionStatusColor(v.status) }} />
                  <span className="search-item__body">
                    <span className="search-item__title">{sessionDisplayTitle(v)}</span>
                    {v.outputTail && <span className="search-item__preview">{v.outputTail}</span>}
                    <span className="search-item__meta">
                      <ToolIcon toolId={v.toolId} size={10} brandColor />
                      {v.toolId}&nbsp;·&nbsp;{basename(v.workspacePath)}
                      <span className="search-item__status">
                        <span className="search-item__status-dot" style={{ background: sessionStatusColor(v.status) }} />
                        {sessionStatusLabel(v.status)}
                      </span>
                      {v.lastActivityAt && <span className="search-item__time">{relativeTime(v.lastActivityAt)}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}

          {showCli && cliViews.length > 0 && (
            <>
              <div className="search-group-label">{t('channels.search.groupCli')}</div>
              {cliViews.map((v) => (
                <button key={v.id} type="button" className="search-item" onClick={() => handleSelectSession(v.id)}>
                  <span className="search-item__dot" style={{ background: sessionStatusColor(v.status) }} />
                  <span className="search-item__body">
                    <span className="search-item__title">{sessionDisplayTitle(v)}</span>
                    {v.outputTail && <span className="search-item__preview">{v.outputTail}</span>}
                    <span className="search-item__meta">
                      <ToolIcon toolId={v.toolId} size={10} brandColor />
                      {v.toolId}&nbsp;·&nbsp;{basename(v.workspacePath)}
                      <span className="search-item__status">
                        <span className="search-item__status-dot" style={{ background: sessionStatusColor(v.status) }} />
                        {sessionStatusLabel(v.status)}
                      </span>
                      {v.lastActivityAt && <span className="search-item__time">{relativeTime(v.lastActivityAt)}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}

          {visibleHits.length > 0 && (
            <>
              <div className="search-group-label">{t('channels.search.groupContent')}</div>
              {visibleHits.map((hit) => (
                <button
                  key={`${hit.toolId}:${hit.nativeSessionId}`}
                  type="button"
                  className="search-item"
                  onClick={() => handleSelectHit(hit)}
                >
                  <span className="search-item__dot" style={{ background: 'var(--text-muted)' }} />
                  <span className="search-item__body">
                    <span className="search-item__title">{sanitizeTranscriptTitle(hit.title) || hit.title || hit.nativeSessionId}</span>
                    {hit.snippetHtml && (
                      <span
                        className="search-item__preview search-item__snippet"
                        // snippetHtml 来自受信任的内部索引（em 标签高亮），非用户输入
                        dangerouslySetInnerHTML={{ __html: hit.snippetHtml }}
                      />
                    )}
                    <span className="search-item__meta">
                      <ToolIcon toolId={hit.toolId} size={10} brandColor />
                      {hit.toolId}
                      {hit.cwd && <>&nbsp;·&nbsp;{basename(hit.cwd)}</>}
                      &nbsp;·&nbsp;{t('channels.search.messageCount', { count: hit.messageCount })}
                      {hit.lastActivityAt && <span className="search-item__time">{relativeTime(hit.lastActivityAt)}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}
          {showKnowledge && knowledgeHits.length > 0 && (
            <>
              <div className="search-group-label">{t('memory.atlas.knowledge.listAria')}</div>
              {knowledgeHits.map((article) => (
                <button key={article.id} type="button" className="search-item" onClick={() => handleSelectKnowledge(article)}>
                  <span className="search-item__dot" style={{ background: 'var(--tool-codex)' }} />
                  <span className="search-item__body">
                    <span className="search-item__title">{article.title}</span>
                    <span className="search-item__preview">{article.summary}</span>
                    <span className="search-item__meta">{article.topic}&nbsp;·&nbsp;{article.tags.map((tag) => `#${tag}`).join(' ')}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
