import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  workspaceTabIdsForCloseMode,
  type WorkspaceTab,
  type WorkspaceTabCloseMode
} from '@shared/workspace-tabs'
import { useT } from '../lib/i18n'

export type V3Section = 'chat' | 'board' | 'schedule' | 'compare' | 'memory' | 'web' | 'stats'

type TFunction = ReturnType<typeof useT>['t']

/** 取镜头标题（类型安全的键映射，避免动态键串绕过 KeyPath 检查）。 */
function sectionLabel(t: TFunction, section: V3Section): string {
  switch (section) {
    case 'chat':
      return t('workbench.section.chat')
    case 'compare':
      return t('workbench.section.compare')
    case 'board':
      return t('workbench.section.board')
    case 'schedule':
      return t('workbench.section.schedule')
    case 'memory':
      return t('workbench.section.memory')
    case 'web':
      return t('workbench.section.web')
    case 'stats':
      return t('workbench.section.stats')
  }
}

const IcWeb = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 2.5c-1.5 1.5-2.5 3.3-2.5 5.5s1 4 2.5 5.5M8 2.5c1.5 1.5 2.5 3.3 2.5 5.5s-1 4-2.5 5.5M2.5 8h11"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
)

const IcChat = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M2 4.5h12M2 8h9M2 11.5h6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
)

const IcCompare = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="4.5" width="5.5" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <rect x="9" y="2.5" width="5.5" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)

const IcBoard = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="2.5" width="4.8" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.25" />
    <rect
      x="9.2"
      y="2.5"
      width="4.8"
      height="7"
      rx="1.2"
      stroke="currentColor"
      strokeWidth="1.25"
    />
    <path
      d="M3.5 5h1.8M10.7 5h1.8M3.5 7.5h1.8"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
    />
  </svg>
)

const IcSchedule = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 4.8v3.5l2.4 1.5"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const IcMemory = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <ellipse cx="8" cy="5" rx="4.5" ry="1.8" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3.5 5v6c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3.5 8c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)

const IcStats = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M2 12.5L5.5 8 8.5 10.5 12 5.5 14 7.5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const IcSettings = (): React.JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
    <path d="M7.5 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M12.7 7.5a5.2 5.2 0 0 0-.08-.9l1.28-1-.96-1.66-1.54.5a5.2 5.2 0 0 0-1.3-.75L9.8 2H5.2l-.3 1.69a5.2 5.2 0 0 0-1.3.75l-1.54-.5L1.1 5.6l1.28 1a5.2 5.2 0 0 0 0 1.8l-1.28 1 .96 1.66 1.54-.5c.4.3.83.56 1.3.75L5.2 13h4.6l.3-1.69c.47-.19.9-.45 1.3-.75l1.54.5.96-1.66-1.28-1c.05-.3.08-.59.08-.9z"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
  </svg>
)

const IcSearch = (): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8.9 8.9L12 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
)

const IcClose = (): React.JSX.Element => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

const SECTIONS: Record<V3Section, { Icon: () => React.JSX.Element }> = {
  chat: { Icon: IcChat },
  board: { Icon: IcBoard },
  schedule: { Icon: IcSchedule },
  compare: { Icon: IcCompare },
  memory: { Icon: IcMemory },
  web: { Icon: IcWeb },
  stats: { Icon: IcStats }
}

function Tooltip({
  label,
  top,
  left
}: {
  label: string
  top: number
  left: number
}): React.JSX.Element {
  return createPortal(
    <div className="rail-tooltip" style={{ top, left }}>
      {label}
    </div>,
    document.body
  )
}

function tabSection(tab: WorkspaceTab): V3Section {
  if (tab.kind === 'compare') return 'compare'
  if (
    tab.kind === 'memory' ||
    tab.kind === 'memory-detail' ||
    tab.kind === 'memory-new' ||
    tab.kind === 'persona' ||
    tab.kind === 'knowledge'
  )
    return 'memory'
  if (tab.kind === 'web') return 'web'
  return 'chat'
}

function TabIcon({ tab }: { tab: WorkspaceTab }): React.JSX.Element | null {
  if (tab.kind === 'compare') return <IcCompare />
  if (tab.kind === 'web')
    return (
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--tool-codex)',
          flexShrink: 0
        }}
      />
    )
  if (tab.kind === 'session' || tab.kind === 'terminal' || tab.kind === 'cli-history') {
    return (
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--tool-claude)',
          flexShrink: 0
        }}
      />
    )
  }
  return null
}

export function TabBar({
  section,
  tabs,
  activeTabId,
  onHome,
  onTabClick,
  onCloseTab,
  onCloseTabs,
  onSetTabPinned,
  onReorderTab,
  onNew,
  onSearch,
  panelOpen,
  onTogglePanel
}: {
  section: V3Section
  tabs: WorkspaceTab[]
  activeTabId: string | null
  onHome(): void
  onTabClick(id: string): void
  onCloseTab(id: string): void
  onCloseTabs(ids: string[]): void
  onSetTabPinned(id: string, pinned: boolean): void
  onReorderTab(draggedId: string, targetId: string): void
  onNew(): void
  onSearch(): void
  panelOpen: boolean
  onTogglePanel(): void
}): React.JSX.Element {
  const { t } = useT()
  const label = sectionLabel(t, section)
  const Icon = SECTIONS[section].Icon
  const tabsRef = useRef<HTMLDivElement>(null)
  const overflowBtnRef = useRef<HTMLButtonElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(
    null
  )
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const update = (): void => setHasOverflow(el.scrollWidth > el.clientWidth + 2)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [tabs.length])

  const closeTabRange = (targetId: string, mode: WorkspaceTabCloseMode): void => {
    const ids = workspaceTabIdsForCloseMode(tabs, targetId, mode)
    if (ids.length > 0) onCloseTabs(ids)
    setContextMenu(null)
    setTabsMenuOpen(false)
  }

  const toggleTabPinned = (targetId: string, pinned: boolean): void => {
    onSetTabPinned(targetId, pinned)
    setContextMenu(null)
    setTabsMenuOpen(false)
  }

  const openTabContextMenu = (tabId: string, x: number, y: number): void => {
    setContextMenu({ tabId, x, y })
    setTabsMenuOpen(false)
  }

  useEffect(() => {
    const findTabId = (event: MouseEvent): string | null => {
      const target = event.target
      if (!(target instanceof Element)) return null
      return target.closest<HTMLElement>('[data-work-tab-id]')?.dataset.workTabId ?? null
    }

    const openFromEvent = (event: MouseEvent, tabId: string): void => {
      event.preventDefault()
      event.stopPropagation()
      openTabContextMenu(tabId, event.clientX, event.clientY)
    }

    const onContextMenu = (event: MouseEvent): void => {
      const tabId = findTabId(event)
      if (tabId) openFromEvent(event, tabId)
    }

    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 2 && !(event.button === 0 && event.ctrlKey)) return
      const tabId = findTabId(event)
      if (tabId) openFromEvent(event, tabId)
    }

    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('mousedown', onMouseDown, true)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [])

  return (
    <div className="tabbar">
      <div className="tl-zone" aria-hidden="true" />
      <div style={{ width: 25, flexShrink: 0 }} />
      <button className={`home-tab ${!activeTabId ? 'is-active' : ''}`} onClick={onHome}>
        <Icon />
        <span>{label}</span>
        <span className="home-tab__chevron">⌄</span>
      </button>
      <div className="tab-sep" />
      <div ref={tabsRef} className="work-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            data-work-tab-id={tab.id}
            draggable
            className={`work-tab ${tab.id === activeTabId ? 'is-active' : ''} ${tab.pinned ? 'is-pinned' : ''} ${tab.id === draggingTabId ? 'is-dragging' : ''} ${tab.id === dropTargetId ? 'is-drop-target' : ''}`}
            onClick={() => onTabClick(tab.id)}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', tab.id)
              setDraggingTabId(tab.id)
              setDropTargetId(null)
            }}
            onDragEnter={(e) => {
              const dragged = tabs.find((item) => item.id === draggingTabId)
              if (
                !dragged ||
                dragged.id === tab.id ||
                Boolean(dragged.pinned) !== Boolean(tab.pinned)
              )
                return
              e.preventDefault()
              setDropTargetId(tab.id)
            }}
            onDragOver={(e) => {
              const dragged = tabs.find((item) => item.id === draggingTabId)
              if (
                !dragged ||
                dragged.id === tab.id ||
                Boolean(dragged.pinned) !== Boolean(tab.pinned)
              )
                return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              if (dropTargetId === tab.id) setDropTargetId(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              const draggedId = e.dataTransfer.getData('text/plain') || draggingTabId
              if (draggedId && draggedId !== tab.id) onReorderTab(draggedId, tab.id)
              setDraggingTabId(null)
              setDropTargetId(null)
            }}
            onDragEnd={() => {
              setDraggingTabId(null)
              setDropTargetId(null)
            }}
            onMouseDown={(e) => {
              if (e.button !== 2 && !(e.button === 0 && e.ctrlKey)) return
              e.preventDefault()
              e.stopPropagation()
              openTabContextMenu(tab.id, e.clientX, e.clientY)
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return
              e.preventDefault()
              onCloseTab(tab.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              openTabContextMenu(tab.id, e.clientX, e.clientY)
            }}
          >
            <TabIcon tab={tab} />
            <span className="work-tab__title">{tab.title}</span>
            <span
              className="work-tab__close"
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(tab.id)
              }}
            >
              <IcClose />
            </span>
          </button>
        ))}
        <button className="tab-new" onClick={onNew} title={t('workbench.tab.newSession')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 2v10M2 7h10"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="tab-actions">
        {hasOverflow && (
          <button
            ref={overflowBtnRef}
            className={`tab-icon-btn ${tabsMenuOpen ? 'is-active' : ''}`}
            onClick={() => {
              setTabsMenuOpen((open) => !open)
              setContextMenu(null)
            }}
            title={t('workbench.tab.showAll')}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path
                d="M3 5l3.5 3.5L10 5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <button
          className={`tab-icon-btn ${panelOpen ? 'is-active' : ''}`}
          onClick={onTogglePanel}
          title={panelOpen ? t('workbench.panel.collapse') : t('workbench.panel.expand')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M4 2v10M2 5h2M2 7h2M2 9h2M7 5l3 2-3 2"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button className="tab-icon-btn" onClick={onSearch} title={t('common.action.search')}>
          <IcSearch />
        </button>
      </div>
      {contextMenu && (
        <TabContextMenu
          tabs={tabs}
          targetId={contextMenu.tabId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onAction={closeTabRange}
          onTogglePinned={toggleTabPinned}
        />
      )}
      <AllTabsMenu
        anchorRef={overflowBtnRef}
        open={tabsMenuOpen}
        tabs={tabs}
        activeTabId={activeTabId}
        onClose={() => setTabsMenuOpen(false)}
        onTabClick={(id) => {
          onTabClick(id)
          setTabsMenuOpen(false)
        }}
        onCloseTab={onCloseTab}
      />
    </div>
  )
}

function MenuShell({
  style,
  onClose,
  children
}: {
  style: React.CSSProperties
  onClose(): void
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('contextmenu', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('contextmenu', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="tab-menu" style={style}>
      {children}
    </div>,
    document.body
  )
}

function TabContextMenu({
  tabs,
  targetId,
  x,
  y,
  onClose,
  onAction,
  onTogglePinned
}: {
  tabs: WorkspaceTab[]
  targetId: string
  x: number
  y: number
  onClose(): void
  onAction(id: string, action: WorkspaceTabCloseMode): void
  onTogglePinned(id: string, pinned: boolean): void
}): React.JSX.Element {
  const { t } = useT()
  const idx = tabs.findIndex((tab) => tab.id === targetId)
  const target = tabs[idx]
  const item = (
    label: string,
    action: WorkspaceTabCloseMode,
    disabled = false
  ): React.JSX.Element => (
    <button
      className="tab-menu__item"
      disabled={disabled}
      onClick={() => onAction(targetId, action)}
    >
      {label}
    </button>
  )
  const closeable = (mode: WorkspaceTabCloseMode): boolean =>
    workspaceTabIdsForCloseMode(tabs, targetId, mode).length > 0
  return (
    <MenuShell
      onClose={onClose}
      style={{
        position: 'fixed',
        left: Math.min(x, window.innerWidth - 220),
        top: Math.min(y, window.innerHeight - 180),
        width: 210,
        zIndex: 1200
      }}
    >
      {item(t('workbench.tab.close.one'), 'one')}
      {item(t('workbench.tab.close.all'), 'all', !closeable('all'))}
      {item(t('workbench.tab.close.others'), 'others', !closeable('others'))}
      <div className="tab-menu__sep" />
      {item(t('workbench.tab.close.left'), 'left', !closeable('left'))}
      {item(t('workbench.tab.close.right'), 'right', !closeable('right'))}
      <div className="tab-menu__sep" />
      <button
        className="tab-menu__item"
        disabled={!target}
        onClick={() => {
          if (target) onTogglePinned(target.id, !target.pinned)
        }}
      >
        {target?.pinned ? t('workbench.tab.unpin') : t('workbench.tab.pin')}
      </button>
    </MenuShell>
  )
}

function AllTabsMenu({
  anchorRef,
  open,
  tabs,
  activeTabId,
  onClose,
  onTabClick,
  onCloseTab
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  open: boolean
  tabs: WorkspaceTab[]
  activeTabId: string | null
  onClose(): void
  onTabClick(id: string): void
  onCloseTab(id: string): void
}): React.JSX.Element | null {
  const { t } = useT()
  if (!open || !anchorRef.current) return null
  const r = anchorRef.current.getBoundingClientRect()
  return (
    <MenuShell
      onClose={onClose}
      style={{
        position: 'fixed',
        top: r.bottom + 6,
        left: Math.max(8, r.right - 330),
        width: 330,
        maxHeight: Math.min(520, window.innerHeight - r.bottom - 14),
        overflowY: 'auto',
        zIndex: 1200
      }}
    >
      {tabs.map((tab) => (
        <div key={tab.id} className={`tab-list-item ${tab.id === activeTabId ? 'is-active' : ''}`}>
          <button className="tab-list-item__main" onClick={() => onTabClick(tab.id)}>
            <TabIcon tab={tab} />
            <span>{tab.title}</span>
          </button>
          <button
            className="tab-list-item__close"
            onClick={(e) => {
              e.stopPropagation()
              onCloseTab(tab.id)
            }}
            title={t('common.action.close')}
          >
            <IcClose />
          </button>
        </div>
      ))}
    </MenuShell>
  )
}

export function IconRail({
  section,
  onSection,
  onSettings
}: {
  section: V3Section
  onSection(section: V3Section): void
  onSettings(): void
}): React.JSX.Element {
  const { t } = useT()
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null)
  const nav = (['chat', 'board', 'schedule', 'compare', 'memory', 'web', 'stats'] as const).map(
    (key) => ({
      key,
      Icon: SECTIONS[key].Icon,
      label: sectionLabel(t, key)
    })
  )

  return (
    <nav className="icon-rail">
      {nav.map(({ key, Icon, label }) => (
        <RailButton
          key={key}
          active={section === key}
          label={label}
          onClick={() => onSection(key)}
          onTip={setTip}
        >
          <Icon />
        </RailButton>
      ))}
      <div className="rail-spacer" />
      <button
        className="rail-btn"
        title={t('common.label.settings')}
        aria-label={t('common.label.settings')}
        onClick={onSettings}
      >
        <IcSettings />
      </button>
      {tip && <Tooltip {...tip} />}
    </nav>
  )
}

function RailButton({
  active,
  label,
  children,
  onClick,
  onTip
}: {
  active: boolean
  label: string
  children: React.ReactNode
  onClick(): void
  onTip(tip: { label: string; top: number; left: number } | null): void
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      className={`rail-btn ${active ? 'is-active' : ''}`}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      onMouseEnter={() => {
        const r = ref.current?.getBoundingClientRect()
        if (r) onTip({ label, top: r.top + r.height / 2, left: r.right + 8 })
      }}
      onMouseLeave={() => onTip(null)}
    >
      {children}
    </button>
  )
}

export function SectionHero({
  section
}: {
  section: Exclude<V3Section, 'chat' | 'board' | 'schedule' | 'stats'>
}): React.JSX.Element {
  const { t } = useT()
  const Icon = SECTIONS[section].Icon
  const label = sectionLabel(t, section)
  return (
    <div className="section-hero">
      <div className="section-hero__icon">
        <Icon />
      </div>
      <div className="section-hero__title">{label}</div>
      <div className="section-hero__sub">{t('workbench.hero.sectionHint', { label })}</div>
    </div>
  )
}

export { tabSection }
