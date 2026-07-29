import type { FC, MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useRef } from 'react'
import { CloseSmall, Memory, Monitor, Plus } from '@icon-park/react'
import { ToolIcon, IpIcon } from '../lib/toolIcons'
import { useSessionsStore } from '../stores/sessionsStore'
import { useWorkspaceTabsStore } from '../stores/workspaceTabsStore'
import { useT } from '../lib/i18n'
import {
  closeWorkspaceTabView,
  focusWorkspaceTab,
  navigateToPage
} from './navigation'
import type { WorkspaceTab } from '@shared/workspace-tabs'
import './workspace-tabs.css'

type IpIconFC = FC<{
  theme: string
  size: number
  strokeWidth: number
  fill?: string[]
  className?: string
}>

function TabGlyph({ tab }: { tab: WorkspaceTab }): React.JSX.Element {
  if (tab.kind === 'session' && tab.toolId) {
    return <ToolIcon toolId={tab.toolId} size={13} />
  }
  return (
    <IpIcon
      icon={(tab.kind === 'compare' ? Monitor : Memory) as IpIconFC}
      size={13}
    />
  )
}

export function WorkspaceTabBar(): React.JSX.Element {
  const tabs = useWorkspaceTabsStore((state) => state.tabs)
  const activeTabId = useWorkspaceTabsStore((state) => state.activeTabId)
  const selectSession = useSessionsStore((state) => state.select)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { t } = useT()

  // 新建 = 回到当前模式工作台空态（Hero），不再弹模态（SPEC-005 v2）。
  const startNew = (): void => {
    navigateToPage('workbench')
    selectSession(null)
  }

  useEffect(() => {
    if (!activeTabId) return
    const active = scrollRef.current?.querySelector<HTMLElement>(
      `[data-workspace-tab-id="${CSS.escape(activeTabId)}"]`
    )
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [activeTabId, tabs.length])

  const handleAuxClick = (event: ReactMouseEvent, id: string): void => {
    if (event.button !== 1) return
    event.preventDefault()
    closeWorkspaceTabView(id)
  }

  return (
    <div className="workspace-tabs" aria-label={t('workbench.tabs.openContexts')}>
      <div
        ref={scrollRef}
        className="workspace-tabs__scroller"
        role="tablist"
        onWheel={(event) => {
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
          event.currentTarget.scrollLeft += event.deltaY
        }}
      >
        {tabs.length === 0 && (
          <span className="workspace-tabs__empty">{t('workbench.tabs.emptyHint')}</span>
        )}
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-workspace-tab-id={tab.id}
              className={`workspace-tab ${active ? 'is-active' : ''}`}
              title={tab.title}
              onClick={() => focusWorkspaceTab(tab.id)}
              onAuxClick={(event) => handleAuxClick(event, tab.id)}
            >
              <span className="workspace-tab__glyph" aria-hidden="true">
                <TabGlyph tab={tab} />
              </span>
              <span className="workspace-tab__title">{tab.title}</span>
              <span
                role="button"
                tabIndex={-1}
                className="workspace-tab__close"
                aria-label={t('workbench.tabs.closeAria', { title: tab.title })}
                onClick={(event) => {
                  event.stopPropagation()
                  closeWorkspaceTabView(tab.id)
                }}
              >
                <IpIcon icon={CloseSmall as IpIconFC} size={13} />
              </span>
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className="workspace-tabs__new"
        onClick={startNew}
        title={t('workbench.tabs.newHint')}
        aria-label={t('workbench.tabs.newAria')}
      >
        <IpIcon icon={Plus as IpIconFC} size={14} />
      </button>
    </div>
  )
}
