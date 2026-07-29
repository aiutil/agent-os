// 会话卡（SPEC-005/017）。左侧 2px 竖线表状态色；meta 行展示 CLI 品牌图标 + 名称。

import { useSessionsStore } from '../../stores/sessionsStore'
import { useAnnotationsStore } from '../../stores/annotationsStore'
import { sessionStatusColor, sessionStatusLabel, sessionStatusPulsing } from '../../lib/status'
import { relativeTime } from '../../lib/time'
import { ToolIcon } from '../../lib/toolIcons'
import { useT } from '../../lib/i18n'
import { annotationTargetKey } from '@shared/types'
import type { AnnotationTargetRef, WorkbenchSessionView } from '@shared/types'
import { openWorkspaceTab } from '../../workspace-tabs/navigation'
import { sessionDisplayTitle } from '../../lib/sessionTitle'

interface SessionCardProps {
  view: WorkbenchSessionView
}

export function SessionCard({ view }: SessionCardProps): React.JSX.Element {
  const selectedId = useSessionsStore((s) => s.selectedId)
  const toggleFavorite = useSessionsStore((s) => s.toggleFavorite)
  const resume = useSessionsStore((s) => s.resume)
  const entries = useAnnotationsStore((s) => s.entries)
  const { t, lang } = useT()

  const color = sessionStatusColor(view.status)
  const pulsing = sessionStatusPulsing(view.status)
  const ref: AnnotationTargetRef = { kind: 'conversation', source: 'managed', convId: view.id }
  const annotation = entries.get(annotationTargetKey(ref)) ?? { favorite: false, tags: [] }
  const title = sessionDisplayTitle(view)
  const openView = (): void =>
    openWorkspaceTab({
      kind: 'session',
      resourceId: view.id,
      title,
      toolId: view.toolId
    })

  return (
    <div
      className={`session-card ${selectedId === view.id ? 'is-selected' : ''}`}
      style={{ ['--status-color' as string]: color }}
    >
      <button
        type="button"
        className="session-card__main"
        aria-label={`${title}，${sessionStatusLabel(view.status)}`}
        onClick={openView}
      >
        <span className={`session-card__dot ${pulsing ? 'is-pulsing' : ''}`} aria-hidden="true" />
        <span className="session-card__body">
          <span className="session-card__name">{title}</span>
          <span className="session-card__meta">
            <ToolIcon toolId={view.toolId} size={11} brandColor className="session-card__tool-icon" />
            <span className="session-card__tool-name">{view.toolId}</span>
            {view.relaySource && <span className="session-card__relay-chip">接力</span>}
            {view.relayTarget && <span className="session-card__relay-chip">来源</span>}
            <span className="session-card__meta-sep">·</span>
            {view.relayTarget
              ? `可继续 · 已接力给 ${view.relayTarget.toolId}`
              : view.relaySource
                ? `进行中 · 接力自 ${view.relaySource.toolId}`
                : sessionStatusLabel(view.status)}
            <span className="session-card__meta-sep">·</span>
            {relativeTime(view.lastActivityAt, lang)}
          </span>
        </span>
      </button>
      {view.surface === 'terminal' && !view.terminalSessionId && view.status === 'resumable' && (
        <button
          type="button"
          className="session-card__action"
          onClick={() => void resume(view.id).then(openView)}
        >
          {t('workbench.session.resume')}
        </button>
      )}
      <button
        type="button"
        className={`session-card__star ${view.favorite ? 'is-on' : ''}`}
        aria-pressed={view.favorite}
        aria-label={view.favorite ? t('workbench.session.unfavorite') : t('workbench.session.favorite')}
        onClick={() => void toggleFavorite(view.id, !view.favorite)}
      >
        {view.favorite ? '★' : '☆'}
      </button>
      <button
        type="button"
        className={`session-card__tag ${annotation.tags.length > 0 ? 'is-on' : ''}`}
        aria-label={t('memory.storage.editTagsAria')}
        onClick={openView}
      >
        #
      </button>
      {annotation.tags.length > 0 ? (
        <span className="session-card__tags">
          {annotation.tags.slice(0, 2).map((tag) => (
            <button
              key={tag}
              type="button"
              className="session-card__tag-chip"
              title={tag}
              onClick={openView}
            >
              {tag}
            </button>
          ))}
          {annotation.tags.length > 2 ? (
            <button
              type="button"
              className="session-card__tag-chip"
              title={annotation.tags.slice(2).join(' / ')}
              onClick={openView}
            >
              +{annotation.tags.length - 2}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
