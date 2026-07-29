// 项目/工作目录选择器（精确复刻 V3 原型 WorkspaceSelector），数据接真实项目 + selectDirectory。

import { useRef, useState } from 'react'
import { useT } from '../../lib/i18n'
import { PortalMenu } from './PortalMenu'
import { nextWorkspaceMenuStateAfterAddProject } from '@shared/workspace-selector-behavior'

export interface WorkspaceOption {
  key: string
  label: string
  git: boolean
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

const IcFolder = ({ size = 13 }: { size?: number }): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 13 13" fill="none">
    <path d="M1 4.5C1 3.7 1.6 3 2.4 3h2l1 1.3h4.2c.8 0 1.4.6 1.4 1.4V9c0 .8-.6 1.4-1.4 1.4H2.4C1.6 10.4 1 9.8 1 9V4.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
)
const IcFolderGit = ({ size = 13 }: { size?: number }): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 13 13" fill="none">
    <path d="M1 4.5C1 3.7 1.6 3 2.4 3h2l1 1.3h4.2c.8 0 1.4.6 1.4 1.4V9c0 .8-.6 1.4-1.4 1.4H2.4C1.6 10.4 1 9.8 1 9V4.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    <path d="M4.5 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3-1h3" stroke="currentColor" strokeWidth=".85" strokeLinecap="round" />
  </svg>
)
const IcFolderAdd = ({ size = 13 }: { size?: number }): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 13 13" fill="none">
    <path d="M1 4.5C1 3.7 1.6 3 2.4 3h2l1 1.3h4.2c.8 0 1.4.6 1.4 1.4V9c0 .8-.6 1.4-1.4 1.4H2.4C1.6 10.4 1 9.8 1 9V4.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    <path d="M6.5 5.5v3M5 7h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
)

export function WorkspaceSelector({
  value,
  onChange,
  workspaces,
  onAddProject,
  allowManualPath = false,
  addProjectLabel,
  keepOpenOnAddProject = false,
  showAddProject = true
}: {
  value: string | null
  onChange(key: string | null): void
  workspaces: WorkspaceOption[]
  onAddProject(): void | Promise<void>
  allowManualPath?: boolean
  addProjectLabel?: string
  keepOpenOnAddProject?: boolean
  showAddProject?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { t } = useT()
  const btnRef = useRef<HTMLButtonElement>(null)
  const ws = workspaces.find((w) => w.key === value) ?? null
  const pillLabel = ws ? ws.label : value ? basename(value) : t('channels.workspace.home')

  const queryTrimmed = query.trim()
  const filtered = workspaces.filter((w) => {
    const q = query.toLowerCase()
    return w.label.toLowerCase().includes(q) || w.key.toLowerCase().includes(q)
  })
  const looksLikePath =
    queryTrimmed.startsWith('/') ||
    queryTrimmed.startsWith('~/') ||
    /^[A-Za-z]:[\\/]/.test(queryTrimmed)
  const canUseManualPath =
    allowManualPath &&
    looksLikePath &&
    !workspaces.some((w) => w.key === queryTrimmed)

  return (
    <>
      <button
        ref={btnRef}
        className="dir-pill"
        onClick={() => setOpen((o) => !o)}
        style={{ background: open ? 'var(--bg-active)' : 'transparent' }}
      >
        <IcFolder />
        <span>{pillLabel}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          style={{ opacity: 0.45, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }}
        >
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <PortalMenu
        anchorRef={btnRef}
        open={open}
        onClose={() => {
          setOpen(false)
          setQuery('')
        }}
        width={230}
        placement="up"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '8px 10px',
            borderBottom: '1px solid var(--border-subtle)'
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M8 8l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('channels.workspace.searchPlaceholder')}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 12, color: 'var(--text-primary)' }}
          />
        </div>

        <div style={{ maxHeight: 200, overflowY: 'auto', padding: '4px 0' }}>
          {filtered.map((w) => (
            <button
              key={w.key}
              onClick={() => {
                onChange(w.key)
                setOpen(false)
                setQuery('')
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '7px 10px',
                background: w.key === value ? 'var(--bg-hover)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left'
              }}
              onMouseEnter={(e) => {
                if (w.key !== value) e.currentTarget.style.background = 'var(--bg-hover)'
              }}
              onMouseLeave={(e) => {
                if (w.key !== value) e.currentTarget.style.background = 'transparent'
              }}
            >
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{w.git ? <IcFolderGit /> : <IcFolder />}</span>
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {w.label}
              </span>
              {w.key === value && (
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M2 5.5l2.5 2.5 4.5-5" stroke="var(--text-primary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: 10, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>{t('channels.workspace.notFound')}</div>
          )}
          {canUseManualPath && (
            <button
              onClick={() => {
                onChange(queryTrimmed)
                setOpen(false)
                setQuery('')
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '7px 10px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                <IcFolder />
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {t('channels.workspace.usePath', { path: queryTrimmed })}
              </span>
            </button>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '4px 0' }}>
          {showAddProject && (
            <button
              onClick={() => {
                const next = nextWorkspaceMenuStateAfterAddProject({
                  asyncBrowse: keepOpenOnAddProject
                })
                void onAddProject()
                setOpen(next.open)
                if (next.clearQuery) setQuery('')
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '7px 10px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 120ms'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ color: 'var(--text-muted)' }}>
                <IcFolderAdd />
              </span>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)' }}>{addProjectLabel ?? t('channels.workspace.addNew')}</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ color: 'var(--text-muted)' }}>
                <path d="M3.5 2l4 3-4 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <button
            onClick={() => {
              onChange(null)
              setOpen(false)
              setQuery('')
            }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '7px 10px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 12,
              color: 'var(--text-secondary)',
              transition: 'background 120ms'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ color: 'var(--text-muted)' }}>
              <IcFolder size={13} />
            </span>
            {t('channels.workspace.noProject')}
          </button>
        </div>
      </PortalMenu>
    </>
  )
}
