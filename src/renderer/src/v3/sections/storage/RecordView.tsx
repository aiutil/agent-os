// 会话记录回放（只读）。默认只加载最近一页，向上滚动再按需取旧消息。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnnotationTargetRef, WorkbenchSessionView } from '@shared/types'
import { annotationTargetKey } from '@shared/types'
import { sanitizeTranscriptTitle } from '@shared/transcript/title'
import { useMemoryViewStore } from '../../../stores/memoryViewStore'
import { useAnnotationsStore } from '../../../stores/annotationsStore'
import { ToolIcon } from '../../../lib/toolIcons'
import { transcriptHistoryItems, type ChatItem } from '../../../pages/workbench/chat-model'
import { Markdown } from '../../../lib/markdown/Markdown'
import { useContentHighlight } from '../../../lib/useContentHighlight'
import { TagEditor } from './TagEditor'
import { useT } from '../../../lib/i18n'
import { RelayTrigger } from '../../shared/RelayTrigger'
import { InPageSearch } from '../../shared/InPageSearch'

function basename(path: string | null): string {
  if (!path) return '~'
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

// 消息文本预览：单行、截断，用作收藏页展示快照 label。
function messagePreview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// 标题跑马灯：仅当文本超出容器宽度时才滚动，否则普通截断。
function TitleMarquee({ text }: { text: string }): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)
  const [overflow, setOverflow] = useState(0)

  useEffect(() => {
    const measure = (): void => {
      const wrap = wrapRef.current
      const span = textRef.current
      if (!wrap || !span) return
      const diff = span.scrollWidth - wrap.clientWidth
      setOverflow(diff > 4 ? diff : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (wrapRef.current) ro.observe(wrapRef.current)
    if (textRef.current) ro.observe(textRef.current)
    return () => ro.disconnect()
  }, [text])

  // 滚动时长随溢出距离线性增长，给个下限避免短溢出过快。
  const style = overflow
    ? ({
        '--marquee-shift': `-${overflow}px`,
        '--marquee-duration': `${Math.max(6, Math.round(overflow / 30))}s`
      } as React.CSSProperties)
    : undefined

  return (
    <div className="title-marquee" ref={wrapRef} title={text}>
      <span
        ref={textRef}
        className={`title-marquee__text${overflow ? ' is-scrolling' : ''}`}
        style={style}
      >
        {text}
      </span>
    </div>
  )
}

// CLI 历史消息级标注：seq 稳定，构造 msg:cli ref。
function RecordMessageAnno({
  seq,
  toolId,
  nativeSessionId,
  label
}: {
  seq: number
  toolId: string
  nativeSessionId: string
  label: string
}): React.JSX.Element {
  const { t } = useT()
  const ref: AnnotationTargetRef = useMemo(
    () => ({ kind: 'message', source: 'cli', toolId, nativeSessionId, seq }),
    [toolId, nativeSessionId, seq]
  )
  const refKey = useMemo(() => annotationTargetKey(ref), [ref])
  const [editing, setEditing] = useState(false)
  const entries = useAnnotationsStore((s) => s.entries)
  const toggleFavorite = useAnnotationsStore((s) => s.toggleFavorite)
  const loadMany = useAnnotationsStore((s) => s.loadMany)
  useEffect(() => {
    void loadMany([ref])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, loadMany])
  const anno = entries.get(refKey) ?? { favorite: false, tags: [] }
  const meta = { label, toolId }
  return (
    <>
      <button
        type="button"
        className={`anno-star ${anno.favorite ? 'is-active' : ''}`}
        aria-label={anno.favorite ? t('memory.record.unstarMsgAria') : t('memory.record.starMsgAria')}
        onClick={() => void toggleFavorite(ref, !anno.favorite, meta)}
      >
        {anno.favorite ? '★' : '☆'}
      </button>
      <button
        type="button"
        className="anno-tag-btn"
        aria-label={t('memory.record.editMsgTagsAria')}
        onClick={() => setEditing(true)}
      >
        #
      </button>
      {anno.tags.length > 0 ? (
        <span className="anno-tags anno-tags--inline">
          {anno.tags.slice(0, 4).map((tag) => (
            <button
              key={tag}
              type="button"
              className="anno-tag-chip"
              title={tag}
              onClick={() => setEditing(true)}
            >
              {tag}
            </button>
          ))}
          {anno.tags.length > 4 ? (
            <button
              type="button"
              className="anno-tag-chip"
              title={anno.tags.slice(4).join(' / ')}
              onClick={() => setEditing(true)}
            >
              +{anno.tags.length - 4}
            </button>
          ) : null}
        </span>
      ) : null}
      <TagEditor
        open={editing}
        targetRef={ref}
        meta={meta}
        title={t('memory.record.editMsgTagsTitle')}
        onClose={() => setEditing(false)}
      />
    </>
  )
}

function RecordItem({
  item,
  toolId,
  nativeSessionId
}: {
  item: ChatItem
  toolId: string
  nativeSessionId: string
}): React.JSX.Element | null {
  const { t } = useT()
  if (item.kind === 'message') {
    // 仅消息变体可标注（process/tool/thinking 无稳定消息 ref）。
    const anno =
      typeof item.seq === 'number' ? (
        <div className="msg-actions">
          <RecordMessageAnno
            seq={item.seq}
            toolId={toolId}
            nativeSessionId={nativeSessionId}
            label={messagePreview(item.text)}
          />
        </div>
      ) : null

    if (item.role === 'user') {
      return (
        <div className="msg is-user">
          <div className="msg-bubble">
            <Markdown content={item.text} />
          </div>
          {anno}
        </div>
      )
    }
    if (item.role === 'assistant') {
      return (
        <div className="msg is-agent">
          <div className="msg-agent-header">
            <ToolIcon toolId={toolId} size={13} brandColor />
            <span className="msg-agent-name">{toolId}</span>
          </div>
          <div className="msg-body">
            <Markdown content={item.text} />
          </div>
          {anno}
        </div>
      )
    }
    return (
      <div className="msg is-agent">
        <div className="msg-system-note">
          <Markdown content={item.text} />
        </div>
      </div>
    )
  }

  if (item.kind === 'process') {
    return (
      <div className="msg is-agent">
        <details className="agent-process is-completed">
          <summary className="agent-process__head">
            <span className="agent-process__pulse" aria-hidden="true" />
            <span className="agent-process__title">{item.title}</span>
            <span className="agent-process__count">{t('memory.record.stepCount', { count: item.steps.length })}</span>
          </summary>
          <div className="agent-process__body">
            {item.steps.map((step) => (
              <details key={step.id} className={`agent-process-step is-${step.kind} ${step.isError ? 'is-error' : ''}`}>
                <summary className="agent-process-step__head">
                  <span className="agent-process-step__glyph" aria-hidden="true" />
                  <span className="agent-process-step__title">{step.title}</span>
                  {step.detail && <span className="agent-process-step__summary">{step.detail}</span>}
                </summary>
                {(step.detail || step.output) && (
                  <div className="agent-process-step__body">
                    {step.detail && <pre>{step.detail}</pre>}
                    {step.output && <pre>{step.output}</pre>}
                  </div>
                )}
              </details>
            ))}
          </div>
        </details>
      </div>
    )
  }

  if (item.kind === 'tool') {
    return (
      <div className="msg is-agent">
        <div className="tool-block">
          <span className="tool-verb">{item.toolName}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{String(item.result ?? '')}</span>
        </div>
      </div>
    )
  }

  if (item.kind === 'thinking') {
    const preview = item.text.replace(/\s+/g, ' ').slice(0, 80)
    return (
      <div className="msg is-agent">
        <details className="msg-thinking">
          <summary className="msg-thinking__head">
            <span className="msg-thinking__label">{t('memory.record.thinking')}</span>
            <span className="msg-thinking__preview">{preview}</span>
            <svg className="msg-thinking__chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <div className="msg-thinking__body">{item.text}</div>
        </details>
      </div>
    )
  }

  return null
}

export function RecordView({
  sessionId,
  title,
  highlight,
  onHighlightConsumed,
  onRelayed
}: {
  sessionId: string
  title: string
  highlight?: string
  onHighlightConsumed?: () => void
  onRelayed?: (view: WorkbenchSessionView) => void
}): React.JSX.Element {
  const { t } = useT()
  const open = useMemoryViewStore((s) => s.open)
  const close = useMemoryViewStore((s) => s.close)
  const loadBefore = useMemoryViewStore((s) => s.loadBefore)
  const meta = useMemoryViewStore((s) => s.meta)
  const messages = useMemoryViewStore((s) => s.messages)
  const loading = useMemoryViewStore((s) => s.loading)
  const loadingMore = useMemoryViewStore((s) => s.loadingMore)
  const hasMoreBefore = useMemoryViewStore((s) => s.hasMoreBefore)
  const error = useMemoryViewStore((s) => s.error)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')

  useEffect(() => {
    open(sessionId)
    return () => close()
  }, [sessionId, open, close])

  // sessionId 形如 "<toolId>:<nativeSessionId>"，拆出用于 CLI 消息 ref。
  const sep = sessionId.indexOf(':')
  const toolId = meta?.toolId ?? (sep > 0 ? sessionId.slice(0, sep) : sessionId)
  const nativeSessionId = meta?.nativeSessionId ?? (sep > 0 ? sessionId.slice(sep + 1) : '')
  const items = useMemo(() => transcriptHistoryItems(messages), [messages])

  // 高亮当前搜索词：Ctrl+F 打开时用会话内输入，否则用全局搜索带入的词。
  const highlightQuery = findOpen ? findQuery : highlight
  const { count: findCount, index: findIndex, goTo: findGoTo } = useContentHighlight(
    bodyRef,
    highlightQuery,
    items.length,
    findOpen ? undefined : onHighlightConsumed
  )

  // Ctrl/Cmd+F 打开会话内搜索。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="chat-view">
      <div className="chat-header chat-header--record">
        <div className="chat-header__main">
          <span className="chat-header__dot" aria-hidden="true" />
          <TitleMarquee text={sanitizeTranscriptTitle(meta?.title ?? '') || meta?.title || title} />
        </div>
        <div className="chat-header__status">
          <ToolIcon toolId={toolId} size={14} brandColor />
          <span className="chat-header__agent">{toolId}</span>
          <span className="chat-header__cwd">{basename(meta?.cwd ?? null)}/</span>
          <RelayTrigger
            sourceSessionId={sessionId}
            sourceSurface="history"
            sourceToolId={toolId}
            sourceDisplayName={toolId}
            triggerLabel={t('memory.record.relayTo')}
            hideIcon
            onRelayed={onRelayed}
          />
        </div>
      </div>
      <div className="chat-messages" ref={bodyRef} onScroll={() => loadBefore()}>
        {findOpen && (
          <InPageSearch
            query={findQuery}
            onQueryChange={setFindQuery}
            count={findCount}
            index={findIndex}
            onGoTo={findGoTo}
            onClose={() => {
              setFindOpen(false)
              setFindQuery('')
            }}
          />
        )}
        {error ? (
          <div className="cli-history-empty">{error}</div>
        ) : loading ? (
          <div className="cli-history-empty">{t('common.state.loading')}</div>
        ) : (
          <>
            {hasMoreBefore && (
              <button className="record-load-more" disabled={loadingMore}>
                {loadingMore ? t('common.state.loading') : t('memory.record.loadMore')}
              </button>
            )}
            {items.length === 0 ? (
              <div className="cli-history-empty">{t('memory.record.empty')}</div>
            ) : (
              items.map((item) => (
                <RecordItem
                  key={item.id}
                  item={item}
                  toolId={toolId}
                  nativeSessionId={nativeSessionId}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}
