// 长期记忆单条详情：只读查看 + 编辑 + 置顶 + 删除；以及手动新建（create 模式）。
// 在内容页渲染，由 workspace tab kind='memory-detail'（查看）/'memory-new'（新建）驱动，
// 与「会话 → RecordView」对称。编辑/新建共用同一组表单字段。

import { useEffect, useState } from 'react'
import type { DurableMemory, ProposeMemoryInput } from '@shared/types'
import { Markdown } from '../../../lib/markdown/Markdown'
import { relativeTime } from '../../../lib/time'
import { useT } from '../../../lib/i18n'
import { localeFor } from '@shared/i18n'

const KIND_OPTIONS: readonly DurableMemory['kind'][] = [
  'preference', 'convention', 'decision', 'fact', 'procedure', 'pitfall', 'knowledge'
]
const SCOPE_OPTIONS: readonly DurableMemory['scope'][] = ['user', 'project', 'repo', 'path', 'agent']

interface Draft {
  title: string
  content: string
  kind: DurableMemory['kind']
  scope: DurableMemory['scope']
  scopeRef: string
  tags: string
}

const EMPTY_DRAFT: Draft = { title: '', content: '', kind: 'knowledge', scope: 'user', scopeRef: '', tags: '' }

function parseTags(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean)
}

// 编辑/新建共用的表单字段；不含标题（标题在各自上下文里单独承载）。
function MemoryFormFields({ draft, onChange }: { draft: Draft; onChange(patch: Partial<Draft>): void }): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="storage-form-grid memory-form">
      <input
        value={draft.title}
        onChange={(e) => onChange({ title: e.target.value })}
        aria-label={t('memory.detail.field.titleAria')}
        placeholder={t('memory.detail.field.titlePlaceholder')}
        className="mem-field memory-form__title"
      />
      <textarea
        value={draft.content}
        onChange={(e) => onChange({ content: e.target.value })}
        aria-label={t('memory.detail.field.contentAria')}
        placeholder={t('memory.detail.field.contentPlaceholder')}
        className="mem-field memory-form__content"
      />
      <div className="storage-form-grid storage-form-grid--two">
        <select value={draft.kind} onChange={(e) => onChange({ kind: e.target.value as DurableMemory['kind'] })} aria-label={t('memory.detail.field.kindAria')} className="mem-field memory-form__select">
          {KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <select value={draft.scope} onChange={(e) => onChange({ scope: e.target.value as DurableMemory['scope'] })} aria-label={t('memory.detail.field.scopeAria')} className="mem-field memory-form__select">
          {SCOPE_OPTIONS.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
        </select>
      </div>
      {draft.scope !== 'user' && (
        <input value={draft.scopeRef} onChange={(e) => onChange({ scopeRef: e.target.value })} aria-label={t('memory.detail.field.scopeRefAria')} placeholder={draft.scope === 'agent' ? t('memory.detail.field.scopeRefAgent') : t('memory.detail.field.scopeRefPath')} className="mem-field memory-form__input" />
      )}
      <input value={draft.tags} onChange={(e) => onChange({ tags: e.target.value })} aria-label={t('memory.detail.field.tagsAria')} placeholder={t('memory.detail.field.tagsPlaceholder')} className="mem-field memory-form__input" />
    </div>
  )
}

// ─── 手动新建记忆 ─────────────────────────────────────────────────────────────
function MemoryCreateView({
  onCreated,
  onCancel
}: {
  onCreated(rec: { id: string; title: string }): void
  onCancel(): void
}): React.JSX.Element {
  const { t } = useT()
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = (patch: Partial<Draft>): void => setDraft((prev) => ({ ...prev, ...patch }))

  const save = (): void => {
    if (!draft.title.trim() || !draft.content.trim()) {
      setError(t('memory.detail.error.titleContentEmpty'))
      return
    }
    const input: ProposeMemoryInput = {
      kind: draft.kind,
      title: draft.title,
      content: draft.content,
      scope: draft.scope,
      ...(draft.scopeRef.trim() ? { scopeRef: draft.scopeRef.trim() } : {}),
      tags: parseTags(draft.tags)
    }
    setBusy(true)
    setError(null)
    void window.agentOs.memory
      .createManual(input)
      .then((created) => onCreated({ id: created.id, title: created.title }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('memory.detail.error.createFailed')))
      .finally(() => setBusy(false))
  }

  return (
    <div className="chat-view storage-page">
      <div className="chat-header">
        <div className="chat-header__name">{t('memory.detail.createTitle')}</div>
        <div className="chat-header__status" style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" className="mem-act is-accent" onClick={save} disabled={busy}>{t('common.action.save')}</button>
          <button type="button" className="mem-act" onClick={onCancel} disabled={busy}>{t('common.action.cancel')}</button>
        </div>
      </div>
      <div className="chat-messages storage-page__body">
        <div className="storage-page__inner memory-page__inner">
          <div className="storage-note">
            {t('memory.detail.createNote')}
          </div>
          <div className="storage-card memory-editor-card">
            <div className="storage-card__body storage-card__body--compact">
              <MemoryFormFields draft={draft} onChange={change} />
              {error && <div className="storage-error">{error}</div>}
              <div className="storage-helper">{t('memory.detail.scopeRefHint')}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 单条详情：查看 / 编辑 / 置顶 / 删除 ──────────────────────────────────────
function MemoryDetail({
  memoryId,
  embedded = false,
  onChanged
}: {
  memoryId: string
  embedded?: boolean
  onChanged?(memory: DurableMemory | null): void
}): React.JSX.Element {
  const { t, lang } = useT()
  const [memory, setMemory] = useState<DurableMemory | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editError, setEditError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setLoading(true)
    void window.agentOs.memory
      .getDurable(memoryId)
      .then(setMemory)
      .catch(() => setMemory(null))
      .finally(() => setLoading(false))
  }, [memoryId])

  const beginEdit = (): void => {
    if (!memory) return
    setEditing(true)
    setConfirmingDelete(false)
    setDraft({
      title: memory.title,
      content: memory.content,
      kind: memory.kind,
      scope: memory.scope,
      scopeRef: memory.scopeRef ?? '',
      tags: memory.tags.join(', ')
    })
    setEditError(null)
  }

  const saveEdit = (): void => {
    if (!memory) return
    setBusy(true)
    void window.agentOs.memory
      .updateDurable(memory.id, {
        title: draft.title,
        content: draft.content,
        kind: draft.kind,
        scope: draft.scope,
        scopeRef: draft.scopeRef.trim() || null,
        tags: parseTags(draft.tags)
      })
      .then((updated) => {
        if (!updated) throw new Error(t('memory.detail.error.notExists'))
        setEditing(false)
        setMemory(updated)
        onChanged?.(updated)
      })
      .catch((error: unknown) => {
        setEditError(error instanceof Error ? error.message : t('memory.detail.error.saveFailed'))
      })
      .finally(() => setBusy(false))
  }

  const togglePin = (): void => {
    if (!memory) return
    setBusy(true)
    void window.agentOs.memory
      .updateDurable(memory.id, { pinned: !memory.pinned })
      .then((updated) => {
        if (updated) {
          setMemory(updated)
          onChanged?.(updated)
        }
      })
      .finally(() => setBusy(false))
  }

  const doDelete = (): void => {
    if (!memory) return
    setBusy(true)
    void window.agentOs.memory
      .forget(memory.id)
      .then(() => {
        setMemory(null)
        setConfirmingDelete(false)
        onChanged?.(null)
      })
      .finally(() => setBusy(false))
  }

  if (loading) {
    return (
      <div className={embedded ? 'memory-detail-pane' : 'chat-view storage-page'}>
        <div className={embedded ? 'memory-detail-pane__state' : 'chat-messages storage-page__body'}>
          <div className="cli-history-empty">{t('common.state.loading')}</div>
        </div>
      </div>
    )
  }
  if (!memory) {
    return (
      <div className={embedded ? 'memory-detail-pane' : 'chat-view storage-page'}>
        <div className={embedded ? 'memory-detail-pane__state' : 'chat-messages storage-page__body'}>
          <div className="cli-history-empty">{t('memory.detail.notFound')}</div>
        </div>
      </div>
    )
  }

  const evidenceText = memory.evidence.map((item) => `${item.sourceType}:${item.sourceId}`).join(' · ') || t('memory.detail.evidenceManual')

  return (
    <div className={embedded ? 'memory-detail-pane' : 'chat-view storage-page'}>
      <div className={embedded ? 'memory-detail-pane__header' : 'chat-header'}>
        {embedded && <div className="memory-detail-pane__eyebrow">记忆详情</div>}
        <div className={embedded ? 'memory-detail-pane__title' : 'chat-header__name'}>{memory.title}</div>
        <div className={embedded ? 'memory-detail-pane__meta' : 'chat-header__status'} style={{ gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{memory.kind} · {memory.scope}</span>
          <span>{t('memory.detail.storedAt', { time: relativeTime(memory.createdAt) })}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {editing ? (
              <>
                <button type="button" className="mem-act is-accent" onClick={() => saveEdit()} disabled={busy}>
                  {t('memory.detail.saveEdit')}
                </button>
                <button type="button" className="mem-act" onClick={() => { setEditing(false); setEditError(null) }} disabled={busy}>
                  {t('common.action.cancel')}
                </button>
              </>
            ) : confirmingDelete ? (
              <>
                <span style={{ fontSize: 'var(--fs-control)', color: 'var(--status-error)' }}>{t('memory.detail.confirmDelete')}</span>
                <button type="button" className="mem-act is-danger" onClick={doDelete} disabled={busy}>
                  {t('common.action.delete')}
                </button>
                <button type="button" className="mem-act" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                  {t('common.action.cancel')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={`mem-act ${memory.pinned ? 'is-accent' : ''}`}
                  onClick={togglePin}
                  disabled={busy}
                  title={memory.pinned ? t('memory.detail.unpinAria') : t('memory.detail.pinAria')}
                >
                  {memory.pinned ? t('memory.detail.pinned') : t('memory.detail.pin')}
                </button>
                <button type="button" className="mem-act is-accent" onClick={beginEdit}>{t('common.action.edit')}</button>
                <button type="button" className="mem-act" onClick={() => setConfirmingDelete(true)}>{t('common.action.delete')}</button>
              </>
            )}
          </span>
        </div>
      </div>
      <div className={embedded ? 'memory-detail-pane__body' : 'chat-messages storage-page__body'}>
        <div className={embedded ? 'memory-detail-pane__inner' : 'storage-page__inner memory-page__inner'}>
          {editing ? (
            <div className="storage-card memory-editor-card">
              <div className="storage-card__body storage-card__body--compact">
                <MemoryFormFields draft={draft} onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))} />
                <div className="storage-helper">{t('memory.detail.evidenceHint', { evidence: evidenceText })}</div>
                {editError && <div className="storage-error">{editError}</div>}
              </div>
            </div>
          ) : (
            <div className="storage-card">
              <div className="storage-card__body">
                <div className="storage-detail__content">
                  <Markdown content={memory.content} />
                </div>
              </div>
              <div className="storage-foot">
                {memory.tags.length > 0 && <div>{t('memory.detail.tagsLabel', { tags: memory.tags.join(' · ') })}</div>}
                <div>{t('memory.detail.evidenceLabel', { evidence: evidenceText })}</div>
                <div>
                  {t('memory.detail.createdUpdatedAt', { created: new Date(memory.createdAt).toLocaleString(localeFor(lang)), updated: relativeTime(memory.updatedAt) })}
                  {memory.pinned ? ` · ${t('memory.detail.pinnedBadge')}` : ''}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function MemoryDetailView({
  memoryId,
  create,
  onCreated,
  onCancelCreate,
  embedded,
  onChanged
}: {
  memoryId?: string
  create?: boolean
  onCreated?(rec: { id: string; title: string }): void
  onCancelCreate?(): void
  embedded?: boolean
  onChanged?(memory: DurableMemory | null): void
}): React.JSX.Element {
  if (create) {
    return <MemoryCreateView onCreated={(rec) => onCreated?.(rec)} onCancel={() => onCancelCreate?.()} />
  }
  return <MemoryDetail memoryId={memoryId ?? ''} embedded={embedded} onChanged={onChanged} />
}
