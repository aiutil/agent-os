// Web 镜头二级面板：书签快速访问（固定/常用）+ 添加网站（弹窗维护）。

import { useEffect, useState } from 'react'
import type { WebBookmark } from '@shared/types'
import { useUiStore } from '../../../stores/uiStore'
import { useT } from '@renderer/lib/i18n'
import { BookmarkDialog } from './BookmarkDialog'

const IcWeb = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 2.5c-1.5 1.5-2.5 3.3-2.5 5.5s1 4 2.5 5.5M8 2.5c1.5 1.5 2.5 3.3 2.5 5.5s-1 4-2.5 5.5M2.5 8h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

export function WebSecPanel({
  onOpenSite,
  activeSiteId,
  onDialogOpenChange
}: {
  onOpenSite(bookmark: WebBookmark): void
  activeSiteId: string | null
  onDialogOpenChange?(open: boolean): void
}): React.JSX.Element {
  const [list, setList] = useState<WebBookmark[]>([])
  const [dialog, setDialog] = useState(false)
  const { t } = useT()
  const defaultHomeId = useUiStore((s) => s.webDefaultHomeId)

  useEffect(() => {
    void window.agentOs.webagg.listBookmarks().then(setList)
  }, [])
  useEffect(() => {
    onDialogOpenChange?.(dialog)
    return () => onDialogOpenChange?.(false)
  }, [dialog, onDialogOpenChange])

  const pinned = list.filter((b) => b.pinned)
  const custom = list.filter((b) => !b.pinned)
  const effectiveDefaultHomeId = list.some((b) => b.id === defaultHomeId) ? defaultHomeId : list[0]?.id ?? null

  const Item = ({ b }: { b: WebBookmark }): React.JSX.Element => {
    const domain = b.url.replace(/^https?:\/\//, '').replace(/^www\./, '')
    return (
      <div
        className={`web-site-item ${activeSiteId === b.id ? 'is-on' : ''}`}
        onClick={() => onOpenSite(b)}
      >
        <div className="web-favicon" style={{ background: b.color }}>{b.name.slice(0, 2)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--text-primary)' }}>{b.name}</div>
          <div style={{ fontSize: 9.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{domain}</div>
        </div>
        {effectiveDefaultHomeId === b.id && (
          <span
            title={t('web.bookmark.defaultHomeTitle')}
            style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-primary)', flexShrink: 0 }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 5.5 6 2l4 3.5V10H7.2V7.2H4.8V10H2V5.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </div>
    )
  }

  return (
    <>
      <div style={{ padding: '7px 7px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', background: 'var(--bg-active)', borderRadius: 7, fontSize: 11, color: 'var(--text-muted)' }}>
          <IcWeb />
          {t('web.secPanel.quickAccess')}
        </div>
      </div>
      <div className="panel-divider" style={{ margin: '0 7px' }} />
      <div className="sec-scroll">
        {pinned.length > 0 && <div className="panel-group-label">{t('web.secPanel.pinned')}</div>}
        {pinned.map((b) => (
          <Item key={b.id} b={b} />
        ))}
        {custom.length > 0 && <div className="panel-group-label">{t('web.secPanel.frequent')}</div>}
        {custom.map((b) => (
          <Item key={b.id} b={b} />
        ))}
        <div className="panel-divider" style={{ margin: '6px 0' }} />
        <button
          onClick={() => setDialog(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 7px', borderRadius: 6, border: 'none', background: 'transparent', font: 'inherit', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', width: '100%', textAlign: 'left' }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          {t('web.secPanel.addSite')}
        </button>
      </div>
      {dialog && <BookmarkDialog onClose={() => setDialog(false)} onChanged={setList} />}
    </>
  )
}
