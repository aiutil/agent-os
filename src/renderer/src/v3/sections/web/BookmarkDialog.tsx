// 书签管理弹窗：新增/删除任意网站书签。

import { useEffect, useState } from 'react'
import type { WebBookmark } from '@shared/types'
import { useUiStore } from '../../../stores/uiStore'
import { useT } from '@renderer/lib/i18n'

export function BookmarkDialog({
  onClose,
  onChanged
}: {
  onClose(): void
  onChanged(list: WebBookmark[]): void
}): React.JSX.Element {
  const { t } = useT()
  const [list, setList] = useState<WebBookmark[]>([])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const defaultHomeId = useUiStore((s) => s.webDefaultHomeId)
  const setDefaultHomeId = useUiStore((s) => s.setWebDefaultHomeId)

  const refresh = (next: WebBookmark[]): void => {
    setList(next)
    onChanged(next)
  }

  useEffect(() => {
    void window.agentOs.webagg.listBookmarks().then(setList)
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const add = (): void => {
    if (!url.trim()) return
    void window.agentOs.webagg.addBookmark({ name: name.trim(), url: url.trim() }).then((next) => {
      refresh(next)
      setName('')
      setUrl('')
    })
  }
  const remove = (id: string): void => {
    void window.agentOs.webagg.removeBookmark(id).then((next) => {
      refresh(next)
      if (defaultHomeId === id) setDefaultHomeId(next[0]?.id ?? null)
    })
  }
  const startEdit = (bookmark: WebBookmark): void => {
    setEditingId(bookmark.id)
    setEditName(bookmark.name)
    setEditUrl(bookmark.url)
  }
  const saveEdit = (): void => {
    if (!editingId || !editUrl.trim()) return
    void window.agentOs.webagg
      .updateBookmark(editingId, { name: editName.trim(), url: editUrl.trim() })
      .then((next) => {
        refresh(next)
        setEditingId(null)
        setEditName('')
        setEditUrl('')
      })
  }

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(24,24,27,.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div style={{ width: 460, background: 'var(--bg-card)', border: '1px solid var(--border-medium)', borderRadius: 14, boxShadow: '0 16px 48px rgba(24,24,27,.22)', padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>{t('web.bookmark.manageTitle')}</div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('web.bookmark.namePlaceholder')}
            style={{ width: 120, height: 34, border: '1px solid var(--border-medium)', borderRadius: 8, padding: '0 10px', background: 'var(--bg-surface)', fontSize: 12, color: 'var(--text-primary)', outline: 'none' }}
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
            placeholder="https://example.com"
            style={{ flex: 1, height: 34, border: '1px solid var(--border-medium)', borderRadius: 8, padding: '0 10px', background: 'var(--bg-surface)', fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', outline: 'none' }}
          />
          <button
            onClick={add}
            disabled={!url.trim()}
            style={{ height: 34, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--text-primary)', color: 'var(--bg-surface)', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: url.trim() ? 1 : 0.5 }}
          >
            {t('common.action.add')}
          </button>
        </div>

        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
          {list.length === 0 && <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>{t('web.bookmark.empty')}</div>}
          {list.map((b, i) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: i < list.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
              <div style={{ width: 22, height: 22, borderRadius: 6, background: b.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'white', flexShrink: 0 }}>{b.name.slice(0, 2)}</div>
              {editingId === b.id ? (
                <>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 6 }}>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={{ width: 110, height: 30, border: '1px solid var(--border-medium)', borderRadius: 7, padding: '0 8px', background: 'var(--bg-surface)', fontSize: 12, color: 'var(--text-primary)', outline: 'none' }}
                    />
                    <input
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEdit()
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      style={{ flex: 1, minWidth: 0, height: 30, border: '1px solid var(--border-medium)', borderRadius: 7, padding: '0 8px', background: 'var(--bg-surface)', fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', outline: 'none' }}
                    />
                  </div>
                  <button
                    onClick={saveEdit}
                    disabled={!editUrl.trim()}
                    style={{ height: 28, padding: '0 10px', borderRadius: 7, background: 'var(--text-primary)', color: 'var(--bg-surface)', fontSize: 12, fontWeight: 600, opacity: editUrl.trim() ? 1 : 0.5 }}
                  >
                    {t('common.action.save')}
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    style={{ height: 28, padding: '0 8px', borderRadius: 7, border: '1px solid var(--border-medium)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 12 }}
                  >
                    {t('common.action.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>{b.name}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.url}</div>
                  </div>
                  <button
                    onClick={() => startEdit(b)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: '4px 6px' }}
                  >
                    {t('common.action.edit')}
                  </button>
                  <button
                    onClick={() => setDefaultHomeId(b.id)}
                    disabled={defaultHomeId === b.id}
                    style={{ height: 26, padding: '0 8px', borderRadius: 7, border: '1px solid var(--border-medium)', background: defaultHomeId === b.id ? 'var(--bg-active)' : 'var(--bg-card)', color: defaultHomeId === b.id ? 'var(--text-primary)' : 'var(--text-muted)', cursor: defaultHomeId === b.id ? 'default' : 'pointer', fontSize: 12 }}
                  >
                    {defaultHomeId === b.id ? t('web.bookmark.currentHome') : t('web.bookmark.setHome')}
                  </button>
                  <button
                    onClick={() => remove(b.id)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: 4 }}
                    title={t('common.action.delete')}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ height: 34, padding: '0 18px', borderRadius: 8, border: '1px solid var(--border-medium)', background: 'var(--bg-card)', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            {t('common.action.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
