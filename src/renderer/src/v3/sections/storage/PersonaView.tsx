// 用户画像（人格）：全局单份、手动维护的高维协作偏好。
// context() 会把它作为最高优先级 preamble 注入每个 agent 回合（先于长期记忆块）。
// 容器/样式令牌沿用 MemoryDetailView，保持「记忆 / 人格」两栏视觉一致。

import { useEffect, useState } from 'react'
import { useT } from '../../../lib/i18n'
import { localeFor, tr } from '@shared/i18n'

export function PersonaView(): React.JSX.Element {
  const { t, lang } = useT()
  const [draft, setDraft] = useState('')
  const [committed, setCommitted] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    void window.agentOs.memory
      .getPersona()
      .then((text) => {
        setDraft(text)
        setCommitted(text)
      })
      .catch(() => setError(tr('memory.persona.error.loadFailed')))
      .finally(() => setLoading(false))
  }, [])

  const dirty = draft !== committed

  const save = (): void => {
    setBusy(true)
    setError(null)
    void window.agentOs.memory
      .updatePersona(draft)
      .then((value) => {
        setCommitted(value)
        setDraft(value)
        setSavedAt(new Date().toLocaleTimeString(localeFor(lang)))
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('memory.persona.error.saveFailed')))
      .finally(() => setBusy(false))
  }

  const reset = (): void => {
    setDraft(committed)
    setError(null)
  }

  if (loading) {
    return (
      <div className="chat-view storage-page">
        <div className="chat-messages storage-page__body">
          <div className="cli-history-empty">{t('common.state.loading')}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-view storage-page">
      <div className="chat-header">
        <div className="chat-header__name">{t('memory.persona.title')}</div>
        <div className="chat-header__status" style={{ marginLeft: 'auto' }}>
          {dirty ? (
            <>
              <button type="button" className="mem-act is-accent" onClick={save} disabled={busy}>
                {t('common.action.save')}
              </button>
              <button type="button" className="mem-act" onClick={reset} disabled={busy}>
                {t('memory.persona.undo')}
              </button>
            </>
          ) : savedAt ? (
            <span style={{ fontSize: 'var(--fs-meta)' }}>{t('memory.persona.savedAt', { time: savedAt })}</span>
          ) : (
            <span style={{ fontSize: 'var(--fs-meta)' }}>{t('memory.persona.globalHint')}</span>
          )}
        </div>
      </div>
      <div className="chat-messages storage-page__body">
        <div className="storage-page__inner persona-page__inner">
          <div className="persona-hero">
            <span className="persona-glyph persona-glyph--lg" aria-hidden="true" />
            <div className="persona-hero__copy">
              <div className="persona-hero__title">{t('memory.persona.heroTitle')}</div>
              <div className="persona-hero__desc">
                {t('memory.persona.heroDesc')}
              </div>
            </div>
          </div>
          <div className="storage-card persona-editor">
            <div className="persona-editor__head">
              <div>
                <div className="persona-editor__title">{t('memory.persona.editorTitle')}</div>
                <div className="persona-editor__meta">{t('memory.persona.editorMeta')}</div>
              </div>
              <div className="persona-editor__count">{t('memory.persona.charCount', { count: draft.trim().length })}</div>
            </div>
            <div className="storage-card__body storage-card__body--compact persona-editor__body">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('memory.persona.placeholder')}
                className="mem-field persona-editor__textarea"
              />
              {error && <div className="storage-error">{error}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
