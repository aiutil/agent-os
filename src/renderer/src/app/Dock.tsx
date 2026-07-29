// 应用单侧栏（SPEC-001/005 · v2 重构）。
// 顶部：折叠/搜索（贴 Mac 红绿灯）→ 会话/CLI 一级切换 → 新建按钮 → 固定导航 → 会话列表 → 活跃点阵图 → 设置。
// 一级切换（会话/CLI）决定会话列表内容；固定导航（对比/记忆/统计）切换内容区但不影响会话列表。

import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Monitor, Memory, Analysis, Setting, LeftBar } from '@icon-park/react'
import type { StatsActivity } from '@shared/types'
import { localeFor } from '@shared/i18n'
import { useUiStore, type PageKey, type WorkbenchMode } from '../stores/uiStore'
import { useToolsStore } from '../stores/toolsStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useT } from '../lib/i18n'
import { IpIcon } from '../lib/toolIcons'
import { SessionRail } from '../pages/workbench/SessionRail'
import { navigateToPage } from '../workspace-tabs/navigation'
import './Dock.css'

const APP_VERSION = 'v0.2.0-beta'

type IpIconFC = FC<{ theme: string; size: number; strokeWidth: number; fill?: string[]; className?: string }>

interface NavItem {
  key: PageKey
  icon: IpIconFC
}

// 固定导航 —— 工作台（默认）/Web 聚合/总览 已移除：工作台为默认镜头，Web 聚合并入对比，总览隐藏。
const NAV: NavItem[] = [
  { key: 'compare', icon: Monitor as IpIconFC },
  { key: 'memory', icon: Memory as IpIconFC },
  { key: 'stats', icon: Analysis as IpIconFC }
]

const MODES: Array<{ key: WorkbenchMode; icon: React.JSX.Element }> = [
  {
    key: 'chat',
    icon: (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M1 3h10M1 6h7M1 9h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  },
  {
    key: 'cli',
    icon: (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M3.5 4.5l2 2-2 2M7 8.5h2"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
]

// ─── 底部活跃点阵图（点 12 · 给到用户的「惊喜」） ───────────────────────────────

function heatLevel(prompts: number): number {
  if (prompts === 0) return 0
  if (prompts < 3) return 1
  if (prompts < 7) return 2
  if (prompts < 15) return 3
  return 4
}

interface MiniCell {
  level: number
  empty: boolean
}

// 铺满侧栏宽度（与选中会话卡同宽）：固定周数 → 列数 → 由 CSS aspect-ratio 让格子等比铺满。
const HEAT_WEEKS = 26

function buildMiniGrid(days: Array<{ date: string; prompts: number }>): MiniCell[] {
  const tail = HEAT_WEEKS * 7
  const map = new Map(days.map((d) => [d.date, d.prompts]))
  const today = new Date()
  // 让最后一列落在「今天」所在周：先补齐尾部到本周末（周六）。
  const trailing = 6 - today.getDay()
  const cells: MiniCell[] = []
  for (let i = tail - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    cells.push({ level: heatLevel(map.get(key) ?? 0), empty: false })
  }
  // 头部补齐到周日起点
  const firstDay = new Date(today)
  firstDay.setDate(today.getDate() - (tail - 1))
  for (let i = 0; i < firstDay.getDay(); i++) cells.unshift({ level: 0, empty: true })
  // 尾部补齐到周六（未来日占位）
  for (let i = 0; i < trailing; i++) cells.push({ level: 0, empty: true })
  return cells
}

function DockActivity(): React.JSX.Element {
  const { t, lang } = useT()
  const [activity, setActivity] = useState<StatsActivity | null>(null)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // 活跃数据来自记忆/统计索引，索引在启动时异步构建；构建期间轮询直到完成。
    const load = async (): Promise<void> => {
      const data = await window.agentOs.stats.activity({ range: 'all' }).catch(() => null)
      if (!alive) return
      if (data) setActivity(data)
      const status = await window.agentOs.memory.indexStatus().catch(() => null)
      if (alive && status?.building) timer = setTimeout(() => void load(), 3000)
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  const cells = buildMiniGrid(activity?.days ?? [])
  const cols = Math.ceil(cells.length / 7)
  const total = activity?.totalPrompts ?? 0
  const streak = activity?.currentStreak ?? 0

  return (
    <div className="dock__activity" title={t('workbench.activity.title')}>
      <div
        className="dock__activity-grid"
        style={{ aspectRatio: `${cols} / 7` }}
        aria-hidden="true"
      >
        {cells.map((c, i) => (
          <span
            key={i}
            className={`dock__activity-cell${c.empty ? ' is-empty' : ` is-l${c.level}`}`}
          />
        ))}
      </div>
      <div className="dock__activity-meta">
        <span className="dock__activity-stat">
          {t('workbench.activity.interactions', {
            count: new Intl.NumberFormat(localeFor(lang)).format(total)
          })}
          {streak > 0 && (
            <>
              <span className="dock__activity-dot">·</span>
              {t('workbench.activity.streak', { count: streak })}
            </>
          )}
        </span>
        <span className="dock__activity-ver">Agent OS · {APP_VERSION}</span>
      </div>
    </div>
  )
}

// ─── 设置弹层（portal，避免被 dock 裁切） ──────────────────────────────────────

function SettingsPopup({
  anchorRef,
  onClose,
  onOpenSettings
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onOpenSettings: () => void
}): React.JSX.Element | null {
  const { t } = useT()
  const popupRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    const btn = anchorRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    setStyle({
      position: 'fixed',
      bottom: window.innerHeight - rect.top + 4,
      left: rect.left,
      minWidth: Math.max(rect.width, 180)
    })
  }, [anchorRef])

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  // 弹出菜单可达性：打开聚焦首项、ESC 关闭、关闭恢复触发按钮焦点。
  useEffect(() => {
    const firstBtn = popupRef.current?.querySelector('button')
    const trigger = anchorRef.current
    firstBtn?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      trigger?.focus()
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div className="dock__settings-popup" style={style} ref={popupRef}>
      <button type="button" className="dock__settings-popup-item" onClick={onOpenSettings}>
        <span>{t('common.label.settings')}</span>
        <kbd>⌘,</kbd>
      </button>
    </div>,
    document.body
  )
}

export function Dock(): React.JSX.Element {
  const activePage = useUiStore((s) => s.activePage)
  const mode = useUiStore((s) => s.workbenchMode)
  const setMode = useUiStore((s) => s.setWorkbenchMode)
  const openSearchModal = useUiStore((s) => s.openSearchModal)
  const selectSession = useSessionsStore((s) => s.select)
  const openSettingsModal = useUiStore((s) => s.openSettingsModal)
  const collapsed = useUiStore((s) => s.dockCollapsed)
  const setCollapsed = useUiStore((s) => s.setDockCollapsed)
  const results = useToolsStore((s) => s.results)
  const scan = useToolsStore((s) => s.scan)
  const { t } = useT()
  const modeLabel = (key: WorkbenchMode): string =>
    key === 'cli' ? t('workbench.mode.cli') : t('workbench.mode.chat')
  const navLabel = (key: PageKey): string => {
    switch (key) {
      case 'compare':
        return t('workbench.nav.compare')
      case 'memory':
        return t('workbench.nav.memory')
      case 'stats':
        return t('workbench.nav.stats')
      default:
        return ''
    }
  }
  const [settingsPopupOpen, setSettingsPopupOpen] = useState(false)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)

  const onWorkbench = activePage === 'workbench'

  // 一级切换：切镜头 → 回工作台空态（会话列表随之过滤）。
  const switchMode = (next: WorkbenchMode): void => {
    if (next !== mode) setMode(next)
    navigateToPage('workbench')
    selectSession(null)
  }

  // 新建 = 回当前镜头的工作台空态（Hero）。
  const startNew = (): void => {
    navigateToPage('workbench')
    selectSession(null)
  }

  // CLI 能力预热（HeroState/Compare 等也会触发，这里兜底）。
  useEffect(() => {
    if (results.length === 0) void scan()
  }, [results.length, scan])

  const handleSettingsClick = (): void => setSettingsPopupOpen((open) => !open)
  const handleOpenSettings = (): void => {
    setSettingsPopupOpen(false)
    openSettingsModal()
  }

  return (
    <nav className={`dock ${collapsed ? 'is-collapsed' : ''}`} aria-label={t('workbench.dock.navLabel')}>
      {/* 悬浮圆角面板：含 Mac 红绿灯在内的整个左侧操作区为一张浮起卡片 */}
      <div className="dock__panel">
      {/* Titlebar chrome —— 与 Mac 红绿灯同排（折叠 + 搜索），位于卡片顶部 */}
      <div className="dock__chrome">
        <button
          type="button"
          className="dock__collapse-btn"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? t('workbench.dock.expandMenu') : t('workbench.dock.collapseMenu')}
          aria-label={collapsed ? t('workbench.dock.expandMenu') : t('workbench.dock.collapseMenu')}
          aria-pressed={collapsed}
        >
          <LeftBar theme="outline" size={15} strokeWidth={3} />
        </button>
        <button
          type="button"
          className="dock__top-search"
          onClick={openSearchModal}
          aria-label={t('workbench.dock.searchHint')}
          title={t('workbench.dock.searchHint')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* 会话 / CLI 一级切换（学 Claude 桌面端顶部分段） */}
      <div className="dock__modeseg" role="tablist" aria-label={t('workbench.dock.modesLabel')}>
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={onWorkbench && mode === m.key}
            className={`dock__modeseg-btn ${onWorkbench && mode === m.key ? 'is-active' : ''}`}
            onClick={() => switchMode(m.key)}
            title={m.key === 'cli' ? t('workbench.mode.cliHint') : t('workbench.mode.chatHint')}
          >
            {m.icon}
            <span className="dock__label">{modeLabel(m.key)}</span>
          </button>
        ))}
      </div>

      {/* 新对话 / 新 CLI（取代独立「工作台」入口） */}
      <button
        type="button"
        className={`dock__new ${onWorkbench ? 'is-active' : ''}`}
        onClick={startNew}
      >
        <span className="dock__new-plus" aria-hidden="true">
          ＋
        </span>
        <span className="dock__label">{mode === 'cli' ? t('workbench.mode.newCli') : t('workbench.mode.newChat')}</span>
        <kbd className="dock__shortcut">⌘N</kbd>
      </button>

      {/* 固定导航 —— 不影响会话列表显示（点 11） */}
      <div className="dock__group">
        {NAV.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`dock__item ${activePage === item.key ? 'is-active' : ''}`}
            onClick={() => navigateToPage(item.key)}
            title={navLabel(item.key)}
          >
            <span className="dock__glyph">
              <IpIcon icon={item.icon} size={17} />
            </span>
            <span className="dock__label">{navLabel(item.key)}</span>
          </button>
        ))}
      </div>

      {/* 会话列表常驻（点 11：仅一级切换影响其内容） */}
      <SessionRail />

      {/* 底部活跃点阵图（点 12） */}
      <DockActivity />

      {/* 设置 */}
      <button
        ref={settingsButtonRef}
        type="button"
        className="dock__item dock__item--settings"
        onClick={handleSettingsClick}
        title={t('workbench.dock.settingsHint')}
      >
        <span className="dock__glyph">
          <IpIcon icon={Setting as IpIconFC} size={17} />
        </span>
        <span className="dock__label">{t('common.label.settings')}</span>
        <kbd className="dock__shortcut">⌘,</kbd>
      </button>
      </div>

      {settingsPopupOpen && (
        <SettingsPopup
          anchorRef={settingsButtonRef}
          onClose={() => setSettingsPopupOpen(false)}
          onOpenSettings={handleOpenSettings}
        />
      )}
    </nav>
  )
}
