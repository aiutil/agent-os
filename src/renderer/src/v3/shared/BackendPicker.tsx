// SPEC-033：统一后端选择器。
// 把「运行位置」与「ToolSelector」合并成一个分组 PortalMenu：本机一节 + 每个远程节点一节，
// 点一行原子确定 {hostId, toolId}（消除切换节点时引擎列表静默刷新的耦合）。
// 行结构复刻 ToolSelector；状态点用 --status-* 令牌；进入动画由 PortalMenu 的 animateEnter 提供。

import { useEffect, useMemo, useRef, useState } from 'react'
import { NodeIcon, ToolIcon } from '../../lib/toolIcons'
import { useT } from '../../lib/i18n'
import { PortalMenu } from './PortalMenu'
import type { BackendSection, BackendSelection } from '../sections/chat/useSessionLaunch'
import type { ToolOption } from './ToolSelector'

const SEARCH_THRESHOLD = 8

type RenderRow =
  | { kind: 'header'; section: BackendSection }
  | {
      kind: 'option'
      hostId: string
      toolId: string
      option: ToolOption
      flatIdx: number
      section: BackendSection
    }
  | { kind: 'placeholder'; section: BackendSection; text: string }

function statusDotColor(connection: BackendSection['connection']): string {
  switch (connection) {
    case 'local':
    case 'connected':
      return 'var(--status-ok)'
    case 'connecting':
      return 'var(--status-waiting)'
    case 'disabled':
      return 'var(--status-disconnect)'
    default:
      return 'var(--status-disconnect)'
  }
}

export function BackendPicker({
  sections,
  value,
  onChange,
  placement = 'up',
  size = 'sm'
}: {
  sections: BackendSection[]
  value: BackendSelection
  onChange(sel: BackendSelection): void
  placement?: 'up' | 'down'
  /** sm=28（Hero composer）；md=36（CliLaunchDialog）。 */
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const { t } = useT()
  const btnRef = useRef<HTMLButtonElement>(null)
  const statusLabel = (connection: BackendSection['connection']): string => {
    switch (connection) {
      case 'local':
      case 'connected':
        return t('common.state.online')
      case 'connecting':
        return t('common.state.connecting')
      case 'disabled':
        return t('common.state.disabled')
      default:
        return t('common.state.offline')
    }
  }
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const iconSize = size === 'md' ? 17 : 16
  const height = size === 'md' ? 36 : 28

  // 当前选中项（跨所有 section，不受搜索影响）——给 trigger 用。
  const selectedOption = useMemo(() => {
    for (const sec of sections) {
      for (const opt of sec.options) {
        const toolId = opt.key.slice(sec.hostId.length + 1)
        if (sec.hostId === value.hostId && toolId === value.toolId) return opt
      }
    }
    return undefined
  }, [sections, value])

  // 搜索过滤后的 section（保留本机节即便无命中，避免空态）。
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sections
    return sections
      .map((sec) => ({
        ...sec,
        options: sec.options.filter(
          (o) => o.label.toLowerCase().includes(q) || sec.label.toLowerCase().includes(q)
        )
      }))
      .filter((sec) => sec.options.length > 0)
  }, [sections, query])

  // 把 filtered 展平成渲染行（header / option / placeholder），option 带 flatIdx 供键盘导航。
  const { rows, optionCount } = useMemo(() => {
    const out: RenderRow[] = []
    let flatIdx = 0
    for (const sec of filtered) {
      out.push({ kind: 'header', section: sec })
      if (sec.selectable) {
        if (sec.options.length === 0) {
          out.push({ kind: 'placeholder', section: sec, text: t('channels.backend.noCliInSection') })
        } else {
          for (const opt of sec.options) {
            const toolId = opt.key.slice(sec.hostId.length + 1)
            out.push({ kind: 'option', hostId: sec.hostId, toolId, option: opt, flatIdx: flatIdx++, section: sec })
          }
        }
      } else {
        const text =
          sec.connection === 'connecting' ? t('channels.backend.connectingHint') : t('channels.backend.disabledHint')
        out.push({ kind: 'placeholder', section: sec, text })
      }
    }
    return { rows: out, optionCount: flatIdx }
  }, [filtered, t])

  const showSearch = useMemo(() => {
    let n = 0
    for (const sec of sections) n += sec.options.length
    return n > SEARCH_THRESHOLD
  }, [sections])

  // 打开时：把键盘焦点对齐到当前选中项（找不到则首项），并聚焦搜索框。搜索词在 onClose 清。
  useEffect(() => {
    if (!open) return
    const idx = selectedOption
      ? rows.findIndex((r) => r.kind === 'option' && r.option.key === selectedOption.key)
      : rows.findIndex((r) => r.kind === 'option')
    const optionRow = idx >= 0 ? (rows[idx] as Extract<RenderRow, { kind: 'option' }>) : undefined
    setActiveIdx(optionRow ? optionRow.flatIdx : 0)
    if (showSearch) {
      const id = window.setTimeout(() => searchRef.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 键盘导航：↑↓/Home/End 移动活跃项，Enter 选定，Escape 还焦 trigger。
  useEffect(() => {
    if (!open || optionCount === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => (i + 1) % optionCount)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => (i - 1 + optionCount) % optionCount)
      } else if (e.key === 'Home') {
        e.preventDefault()
        setActiveIdx(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        setActiveIdx(optionCount - 1)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const target = rows.find((r) => r.kind === 'option' && r.flatIdx === activeIdx) as
          | Extract<RenderRow, { kind: 'option' }>
          | undefined
        if (target) {
          onChange({ hostId: target.hostId, toolId: target.toolId })
          setOpen(false)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, optionCount, rows, activeIdx, onChange])

  // 活跃行滚入视口。
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx='${activeIdx}']`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('channels.backend.ariaLabel')}
        title={t('channels.backend.title')}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 10px',
          height,
          borderRadius: 7,
          border: 'none',
          background: open ? 'var(--bg-active)' : 'transparent',
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          transition: 'background 160ms',
          font: 'inherit',
          maxWidth: 180
        }}
      >
        {selectedOption ? (
          <ToolIcon toolId={value.toolId} size={iconSize} brandColor />
        ) : (
          <NodeIcon size={iconSize} />
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedOption ? selectedOption.label : t('channels.backend.selectEngine')}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          style={{ opacity: 0.5, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }}
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
        width={256}
        placement={placement}
        animateEnter
      >
        <div ref={listRef} role="listbox" style={{ maxHeight: 340, overflowY: 'auto' }}>
          {showSearch && (
            <div style={{ padding: '4px 6px 6px', position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1 }}>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('channels.backend.searchCli')}
                style={{
                  width: '100%',
                  height: 26,
                  boxSizing: 'border-box',
                  padding: '0 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border-medium)',
                  background: 'var(--bg-base)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                  font: 'inherit',
                  outline: 'none'
                }}
              />
            </div>
          )}
          {rows.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 11.5, color: 'var(--text-muted)' }}>{t('channels.backend.noCliAvailable')}</div>
          )}
          {rows.map((row) => {
            if (row.kind === 'header') {
              const sec = row.section
              return (
                <div
                  key={`h-${sec.hostId}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 10px 3px',
                    marginTop: 2
                  }}
                >
                  {sec.hostId === 'local' ? (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '.04em',
                        textTransform: 'uppercase',
                        color: 'var(--text-muted)',
                        flex: 1
                      }}
                    >
                      {t('channels.backend.local')}
                    </span>
                  ) : (
                    <>
                      <NodeIcon size={11} />
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {sec.label}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{statusLabel(sec.connection)}</span>
                    </>
                  )}
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: statusDotColor(sec.connection),
                      flexShrink: 0
                    }}
                  />
                </div>
              )
            }
            if (row.kind === 'placeholder') {
              return (
                <div
                  key={`p-${row.section.hostId}`}
                  style={{ padding: '3px 10px 7px 27px', fontSize: 10.5, color: 'var(--text-muted)' }}
                >
                  {row.text}
                </div>
              )
            }
            const active = row.flatIdx === activeIdx
            const selected = row.hostId === value.hostId && row.toolId === value.toolId
            return (
              <button
                key={row.option.key}
                type="button"
                role="option"
                aria-selected={selected}
                data-idx={row.flatIdx}
                onMouseMove={() => setActiveIdx(row.flatIdx)}
                onClick={() => {
                  onChange({ hostId: row.hostId, toolId: row.toolId })
                  setOpen(false)
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 10px',
                  borderRadius: 7,
                  border: 'none',
                  background: active ? 'var(--bg-active)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  font: 'inherit'
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 7,
                    background: 'var(--bg-panel)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0
                  }}
                >
                  <ToolIcon toolId={row.toolId} size={15} brandColor />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: selected ? 600 : 500, color: 'var(--text-primary)' }}>
                    {row.option.label}
                  </div>
                  {row.option.sub && (
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1, fontFamily: 'var(--font-mono)' }}>
                      {row.option.sub}
                    </div>
                  )}
                </div>
                {selected && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M2 6l3 3 5-5" stroke="var(--text-primary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      </PortalMenu>
    </>
  )
}
