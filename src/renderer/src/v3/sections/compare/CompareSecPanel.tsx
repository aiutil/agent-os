// 对比镜头二级面板。展示 V3 广播对比方案，并提供新建入口。

import { useEffect, useRef, useState } from 'react'
import type { CompareScenario, CompareScenarioPane } from '@shared/types'
import { ToolIcon } from '../../../lib/toolIcons'
import { useT } from '../../../lib/i18n'

const WEB_META: Record<string, { label: string; color: string }> = {
  chatgpt: { label: 'GPT', color: 'var(--status-working)' },
  gemini: { label: 'Gemini', color: 'var(--tool-gemini)' },
  claude: { label: 'Claude', color: 'var(--tool-claude)' },
  doubao: { label: '豆包', color: 'var(--status-resumable)' },
  yuanbao: { label: '元宝', color: '#3b6cff' },
  kimi: { label: 'Kimi', color: 'var(--status-ok)' },
  deepseek: { label: 'DeepSeek', color: 'var(--tool-openclaw)' },
  grok: { label: 'Grok', color: 'var(--text-primary)' }
}

function paneShortName(pane: CompareScenarioPane): string {
  if (pane.type === 'webchat') return WEB_META[pane.webService ?? '']?.label ?? 'Web'
  return pane.toolId ?? 'CLI'
}

function ScenarioAvatars({ panes }: { panes: CompareScenarioPane[] }): React.JSX.Element {
  return (
    <div className="compare-scenario-avatars">
      {panes.slice(0, 4).map((pane) => {
        if (pane.type === 'webchat') {
          const meta = WEB_META[pane.webService ?? ''] ?? { label: 'Web', color: 'var(--tool-generic)' }
          return (
            <span
              key={pane.id}
              className="compare-scenario-avatar"
              title={meta.label}
              style={{ color: meta.color }}
            >
              {meta.label.slice(0, 1).toUpperCase()}
            </span>
          )
        }
        return (
          <span key={pane.id} className="compare-scenario-avatar" title={pane.toolId}>
            <ToolIcon toolId={pane.toolId ?? 'code'} size={13} brandColor />
          </span>
        )
      })}
    </div>
  )
}

export function CompareSecPanel({
  onNewCompare,
  onOpenScenario,
  onDeleteScenario,
  activeScenarioId
}: {
  onNewCompare(): void
  onOpenScenario(scenario: CompareScenario): void
  onDeleteScenario?(scenarioId: string): void
  activeScenarioId?: string | null
}): React.JSX.Element {
  const { t } = useT()
  const [scenarios, setScenarios] = useState<CompareScenario[]>([])

  const refresh = (): void => {
    void window.agentOs.compare.listScenarios().then(setScenarios).catch(() => setScenarios([]))
  }

  // 用 ref 持有 V3App 回调，避免每次渲染新闭包触发列表重渲染。
  const onDeleteScenarioRef = useRef(onDeleteScenario)
  onDeleteScenarioRef.current = onDeleteScenario
  const handleDelete = async (scenario: CompareScenario): Promise<void> => {
    await window.agentOs.compare.deleteScenario(scenario.id)
    window.dispatchEvent(new CustomEvent('agent-os.compare-scenarios-changed'))
    onDeleteScenarioRef.current?.(scenario.id)
  }

  useEffect(() => {
    refresh()
    const onChanged = (): void => refresh()
    window.addEventListener('agent-os.compare-scenarios-changed', onChanged)
    return () => window.removeEventListener('agent-os.compare-scenarios-changed', onChanged)
  }, [])

  return (
    <>
      <div style={{ padding: '7px 7px 4px' }}>
        <button className="panel-new" onClick={onNewCompare}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>＋</span>
          {t('compare.secPanel.newCompare')}
        </button>
      </div>
      <div className="panel-divider" style={{ margin: '0 7px' }} />
      <div className="sec-scroll">
        {scenarios.length === 0 ? (
          <div style={{ padding: '12px 9px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            {t('compare.secPanel.emptyHint')}
            <br />
            {t('compare.secPanel.emptyHint2')}
          </div>
        ) : (
          <div className="compare-scenario-list">
            {scenarios.map((scenario) => {
              const active = scenario.id === activeScenarioId
              const names = scenario.panes.map(paneShortName).join(' / ')
              return (
                <div
                  key={scenario.id}
                  className={`compare-scenario-item${active ? ' is-active' : ''}`}
                  onClick={() => onOpenScenario(scenario)}
                >
                  <ScenarioAvatars panes={scenario.panes} />
                  <span className="compare-scenario-copy">
                    <span className="compare-scenario-title">{scenario.title}</span>
                    <span className="compare-scenario-meta">{names}</span>
                  </span>
                  <button
                    type="button"
                    className="compare-scenario-item__delete"
                    title={t('compare.secPanel.deleteTitle')}
                    aria-label={t('compare.secPanel.deleteAria', { title: scenario.title })}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDelete(scenario)
                    }}
                  >
                    <svg width="9" height="9" viewBox="0 0 8 8" fill="none">
                      <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
