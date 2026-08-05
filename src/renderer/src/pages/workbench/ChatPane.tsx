import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Refresh } from '@icon-park/react'
import type {
  ChatTurnState,
  ConversationSegment,
  ManagedChatMessage,
  PermissionDecision,
  WorkbenchSessionView
} from '@shared/types'
import { appendUserMessage, applyAgentEvent, transcriptItems, type ChatItem } from './chat-model'
import { useSessionsStore } from '../../stores/sessionsStore'
import { ToolIcon, IpIcon } from '../../lib/toolIcons'
import { Markdown } from '../../lib/markdown/Markdown'
import { useT } from '../../lib/i18n'
import type { Dictionary, KeyPath, Vars } from '@shared/i18n'
import { ToolCard } from './ToolCard'
import { useNotificationStore } from '../../stores/notificationStore'
import './chat.css'

type IpIconFC = FC<{ theme: string; size: number; strokeWidth: number; fill?: string[] }>

function itemId(): string {
  return crypto.randomUUID()
}

function managedHistoryItems(messages: ManagedChatMessage[]): ChatItem[] {
  return messages
    .filter((message) => message.text.trim())
    .map((message) => ({
      id: `managed-${message.id}`,
      kind: 'message',
      role: message.role,
      text: message.text
    }))
}

interface VerbInfo {
  key: KeyPath<Dictionary>
  vars?: Vars
}

/** 取工具动作的翻译键 + 插值变量（编辑/执行/搜索/读取/调用）。 */
function toolVerbInfo(toolName: string): VerbInfo {
  const n = toolName.toLowerCase()
  if (n.includes('edit') || n.includes('write') || n.includes('notebook')) {
    return { key: 'workbench.tool.verb.edit', vars: { name: toolName } }
  }
  if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('command')) {
    return { key: 'workbench.tool.verb.exec' }
  }
  if (n.includes('grep') || n.includes('glob') || n.includes('search') || n.includes('find')) {
    return { key: 'workbench.tool.verb.search' }
  }
  if (n.includes('read') || n.includes('cat') || n.includes('view')) {
    return { key: 'workbench.tool.verb.read', vars: { name: toolName } }
  }
  return { key: 'workbench.tool.verb.generic', vars: { name: toolName } }
}

function PermissionCard({
  item,
  sessionId,
  onResolved
}: {
  item: Extract<ChatItem, { kind: 'permission' }>
  sessionId: string
  onResolved(state: ChatTurnState): void
}): React.JSX.Element {
  const { t } = useT()
  const [submitting, setSubmitting] = useState(false)
  const respond = async (decision: PermissionDecision): Promise<void> => {
    setSubmitting(true)
    try {
      onResolved(await window.agentOs.chat.respondPermission(sessionId, item.requestId, decision))
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <section className="chat-permission">
      <div className="chat-permission__title">
        {t('workbench.chat.permission.title', { name: item.toolName })}
      </div>
      <pre>{JSON.stringify(item.input, null, 2)}</pre>
      <div className="chat-permission__actions">
        <button type="button" disabled={submitting} onClick={() => void respond('deny')}>
          {t('workbench.chat.permission.deny')}
        </button>
        <button type="button" disabled={submitting} onClick={() => void respond('always')}>
          {t('workbench.chat.permission.always')}
        </button>
        <button
          type="button"
          className="is-primary"
          disabled={submitting}
          onClick={() => void respond('once')}
        >
          {submitting
            ? t('workbench.chat.permission.processing')
            : t('workbench.chat.permission.allowOnce')}
        </button>
      </div>
    </section>
  )
}

function ThinkingCard({ text }: { text: string }): React.JSX.Element {
  const { t } = useT()
  return (
    <details className="chat-thinking">
      <summary className="chat-thinking__head">
        <span className="chat-thinking__icon" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 2C4.8 2 3 3.6 3 5.5c0 .9.3 1.6.9 2.2-.4.4-.6 1-.6 1.6C3.3 10.4 4.4 11.5 5.8 11.5c.4 0 .8-.1 1.2-.3.3.2.6.3 1 .3s.7-.1 1-.3c.4.2.8.3 1.2.3 1.4 0 2.5-1.1 2.5-2.2 0-.6-.2-1.2-.6-1.6.6-.6.9-1.3.9-2.2C11 3.6 9.2 2 7 2Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="chat-thinking__label">{t('workbench.chat.thinkingProcess')}</span>
        <span className="chat-thinking__chevron" aria-hidden="true" />
      </summary>
      <div className="chat-thinking__body">
        <p className="chat-thinking__text">{text}</p>
      </div>
    </details>
  )
}

// 段落分隔卡（SPEC-017）
function SegmentSeparator({
  from,
  to
}: {
  from: ConversationSegment
  to: ConversationSegment
}): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="chat-segment-separator" aria-label={t('workbench.chat.handoff.aria')}>
      <span className="chat-segment-separator__icons">
        <ToolIcon toolId={from.toolId} size={13} brandColor />
        <IpIcon icon={Refresh as IpIconFC} size={11} />
        <ToolIcon toolId={to.toolId} size={13} brandColor />
      </span>
      <span className="chat-segment-separator__text">
        {t('workbench.chat.handoff.text', { from: from.toolId, to: to.toolId })}
      </span>
      {to.handoffDocPath && (
        <span className="chat-segment-separator__doc" title={to.handoffDocPath}>
          {t('workbench.chat.handoff.doc')}
        </span>
      )}
    </div>
  )
}

/** 加载所有段落的 transcript，按段拼接，段间插分隔卡。 */
async function loadAllSegments(segments: ConversationSegment[]): Promise<ChatItem[]> {
  const segs = segments.filter((s) => s.nativeSessionId)
  const results: ChatItem[] = []
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    try {
      const transcript = await window.agentOs.memory.getTranscript(
        `${seg.toolId}:${seg.nativeSessionId}`
      )
      if (transcript) {
        results.push(...transcriptItems(transcript.messages))
      }
    } catch {
      // 某段读取失败不阻断其他段
    }
    // 如果后面还有段，插入分隔卡
    if (i < segs.length - 1) {
      const nextSeg = segs[i + 1]
      results.push({
        kind: 'separator' as const,
        id: `sep-${seg.id}`,
        fromSegment: seg,
        toSegment: nextSeg
      } as unknown as ChatItem)
    }
  }
  return results
}

export function ChatPane({ view }: { view: WorkbenchSessionView }): React.JSX.Element {
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [state, setState] = useState<ChatTurnState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const refreshSessions = useSessionsStore((store) => store.refresh)
  const consumePendingPrompt = useSessionsStore((store) => store.consumePendingPrompt)
  const pendingPrompt = useSessionsStore((store) => store.pendingPrompt[view.id])
  const { t } = useT()

  const segments = view.segments ?? []
  const isMultiSegment = segments.length > 1

  useEffect(() => {
    let cancelled = false
    setItems([])
    setLoadError(null)
    void window.agentOs.chat.state(view.id).then((next) => {
      if (!cancelled) {
        setState(next)
        if (next.pendingPermission) {
          setItems((current) => applyAgentEvent(current, next.pendingPermission!, itemId()))
        }
      }
    })

    void (async () => {
      try {
        const managed = await window.agentOs.chat.history(view.id)
        let loaded = managedHistoryItems(managed)
        if (managed.length > 0) {
          if (!cancelled) {
            setItems((current) => [
              ...loaded,
              ...current.filter((item) => item.kind === 'permission')
            ])
          }
          if (!view.nativeSessionId) return
          const transcript = await window.agentOs.memory.getTranscript(
            `${view.toolId}:${view.nativeSessionId}`
          )
          if (!transcript) return
          loaded = [
            ...loaded,
            ...transcriptItems(
              transcript.messages.filter(
                (message) => message.role !== 'user' && message.role !== 'assistant'
              )
            )
          ]
        } else if (isMultiSegment) {
          loaded = await loadAllSegments(segments)
        } else if (view.nativeSessionId) {
          const transcript = await window.agentOs.memory.getTranscript(
            `${view.toolId}:${view.nativeSessionId}`
          )
          if (transcript) loaded = transcriptItems(transcript.messages)
        }
        if (!cancelled) {
          setItems((current) => {
            const permissions = current.filter((item) => item.kind === 'permission')
            return [...loaded, ...permissions]
          })
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [view.id, view.nativeSessionId, view.toolId, isMultiSegment, segments])

  useEffect(
    () =>
      window.agentOs.events.onAgentEvent(({ sessionId, event }) => {
        if (sessionId !== view.id) return
        setItems((current) => applyAgentEvent(current, event, itemId()))
        if (event.kind === 'permission-request') {
          void window.agentOs.chat.state(view.id).then(setState)
        }
        if (event.kind === 'turn-end' || (event.kind === 'error' && !event.retryable)) {
          window.setTimeout(() => {
            void window.agentOs.chat.state(view.id).then(setState)
            void refreshSessions()
          }, 50)
        }
      }),
    [refreshSessions, view.id]
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [items])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && state?.status === 'running') {
        void window.agentOs.chat
          .interrupt(view.id)
          .then(() => window.agentOs.chat.state(view.id).then(setState))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state?.status, view.id])

  const sendText = async (raw: string, files?: string[]): Promise<void> => {
    const text = raw.trim()
    if (!text || state?.status === 'running' || state?.status === 'awaiting-permission') {
      return
    }
    setItems((current) => appendUserMessage(current, text, itemId()))
    setSending(true)
    try {
      const nextState = await window.agentOs.chat.sendTurn(view.id, text, files)
      setState(nextState)
      if (nextState.taskAutomation?.status === 'created') {
        useNotificationStore.getState().show({
          message: t('chat.taskAutomation.created', { title: nextState.taskAutomation.title }),
          tone: 'success'
        })
      } else if (nextState.taskAutomation?.status === 'failed') {
        useNotificationStore.getState().show({
          message: t('chat.taskAutomation.failed', { error: nextState.taskAutomation.error }),
          tone: 'error'
        })
      }
      await refreshSessions()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setItems((current) => applyAgentEvent(current, { kind: 'error', message }, itemId()))
    } finally {
      setSending(false)
    }
  }

  const send = (): void => {
    if (!input.trim()) return
    const text = input
    setInput('')
    void sendText(text)
  }

  // 工作台 Hero 创建会话时暂存的首条消息：进入对话镜头即自动发出（SPEC-005 v2）。
  // 订阅 pendingPrompt[view.id]，规避「会话已选中但 pending 尚未写入」的时序竞态；
  // consume 后该值清空，effect 再次触发即 no-op。
  useEffect(() => {
    if (!pendingPrompt) return
    consumePendingPrompt(view.id)
    void sendText(pendingPrompt.text, pendingPrompt.files)
  }, [pendingPrompt, view.id])

  const running = state?.status === 'running' || state?.status === 'awaiting-permission'

  // 细粒度 working 文案：取最近一个尚未返回结果的工具调用，显示「正在<动作> <名>…」。
  const activeTool = [...items]
    .reverse()
    .find(
      (i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool' && i.result === undefined
    )
  const verbInfo = activeTool ? toolVerbInfo(activeTool.toolName) : null
  const workingText = verbInfo
    ? t('workbench.chat.working', { verb: t(verbInfo.key, verbInfo.vars) })
    : t('workbench.chat.thinking')

  return (
    <section className="chat-pane">
      <div className="chat-thread" aria-live="polite">
        <div className="chat-thread__inner">
          {view.relaySource && (
            <div className="chat-relay-card">
              <strong>{t('workbench.relay.from', { tool: view.relaySource.toolId })}</strong>
              <span>{t('workbench.relay.source', { title: view.relaySource.title })}</span>
              <div className="chat-relay-card__actions">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(view.relaySource?.contextPackPath ?? '')
                  }}
                >
                  {t('workbench.relay.copyContext')}
                </button>
              </div>
            </div>
          )}
          {items.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty__avatar" aria-hidden="true">
                <ToolIcon toolId={view.toolId} size={18} brandColor />
              </div>
              <strong>{view.toolId}</strong>
              <span>{t('workbench.chat.emptyHint')}</span>
            </div>
          )}
          {items.map((item) => {
            // 段落分隔卡（SPEC-017）— 通过强转访问，不影响 ChatItem 联合类型
            if ((item as { kind: string }).kind === 'separator') {
              const sep = item as unknown as {
                id: string
                fromSegment: ConversationSegment
                toSegment: ConversationSegment
              }
              return <SegmentSeparator key={sep.id} from={sep.fromSegment} to={sep.toSegment} />
            }
            if (item.kind === 'message') {
              if (item.role === 'assistant') {
                return (
                  <article key={item.id} className="chat-message is-assistant">
                    <div className="chat-message__avatar" aria-hidden="true">
                      <ToolIcon toolId={view.toolId} size={14} brandColor />
                    </div>
                    <div className="chat-message__body">
                      <div className="chat-message__label">{view.toolId}</div>
                      <div className="chat-message__text">
                        <Markdown content={item.text} />
                      </div>
                    </div>
                  </article>
                )
              }
              return (
                <article key={item.id} className={`chat-message is-${item.role}`}>
                  {item.role !== 'user' && (
                    <div className="chat-message__label">{t('workbench.chat.system')}</div>
                  )}
                  <div className="chat-message__text chat-message__text--plain">{item.text}</div>
                </article>
              )
            }
            if (item.kind === 'thinking') return <ThinkingCard key={item.id} text={item.text} />
            if (item.kind === 'tool') return <ToolCard key={item.id} item={item} />
            if (item.kind === 'process') return null
            if (item.kind === 'unknown') {
              return (
                <details key={item.id} className="chat-unknown">
                  <summary>{t('workbench.chat.unknownEvent', { type: item.rawType })}</summary>
                  <pre>{JSON.stringify(item.payload, null, 2)}</pre>
                </details>
              )
            }
            return (
              <PermissionCard
                key={item.id}
                item={item}
                sessionId={view.id}
                onResolved={(next) => {
                  setState(next)
                  setItems((current) =>
                    current.filter(
                      (candidate) =>
                        candidate.kind !== 'permission' || candidate.requestId !== item.requestId
                    )
                  )
                }}
              />
            )
          })}
          {view.relayTarget && (
            <div className="chat-relay-card">
              <strong>{t('workbench.relay.relayedTo', { tool: view.relayTarget.toolId })}</strong>
              <span>{t('workbench.relay.newSession', { title: view.relayTarget.title })}</span>
            </div>
          )}
          {loadError && (
            <div className="chat-load-error">
              {t('workbench.chat.loadError', { error: loadError })}
            </div>
          )}
          {state?.status === 'running' && (
            <div className="chat-working">
              <span className="chat-working__pulse" />
              {workingText}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="chat-composer">
        <div className="chat-composer__inner">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder={t('workbench.chat.composerPlaceholder', { tool: view.toolId })}
            disabled={state?.status === 'awaiting-permission'}
          />
          <div className="chat-composer__toolbar">
            <span>
              {state?.status === 'awaiting-permission'
                ? t('workbench.chat.awaitingApproval')
                : t('workbench.chat.sendHint')}
            </span>
            {state?.status === 'running' ? (
              <button
                type="button"
                className="chat-interrupt"
                onClick={() =>
                  void window.agentOs.chat
                    .interrupt(view.id)
                    .then(() => window.agentOs.chat.state(view.id).then(setState))
                }
              >
                {t('workbench.chat.interrupt')}
              </button>
            ) : (
              <button
                type="button"
                className="chat-send"
                disabled={!input.trim() || running || sending}
                onClick={() => void send()}
              >
                {sending ? t('workbench.chat.sending') : t('workbench.chat.send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
