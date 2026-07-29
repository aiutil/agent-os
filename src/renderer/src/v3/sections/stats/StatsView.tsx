// 统计镜头内容。UI 复刻原型 StatsView，数据接 stats.summary/activity/growth。
// statsView==='growth' 渲染 Cardex 成长图鉴（GrowthView）。

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type {
  StatsActivity,
  StatsExportView,
  StatsModels,
  StatsQuery,
  StatsRange
} from '@shared/types'
import { useT } from '../../../lib/i18n'
import { Button } from '../../../lib/ui'
import { useNotificationStore } from '../../../stores/notificationStore'
import { useStatsDashboard, useStatsModels } from './useStatsData'
import { GrowthView } from './GrowthView'
import { heatLevel, HEAT_COLORS } from '../../../lib/heatmap'
import { StatsProjectFilter } from './StatsProjectFilter'
import { ProjectStatsView } from './ProjectStatsView'
import { humanizeStatsNumber } from './stats-format'

interface ChartTip {
  x: number
  y: number
  title: string
  lines: string[]
}

const MODEL_COLORS = [
  'var(--tool-codex)',
  'color-mix(in srgb, var(--tool-codex) 78%, var(--bg-card))',
  'color-mix(in srgb, var(--tool-codex) 62%, var(--bg-card))',
  'color-mix(in srgb, var(--tool-codex) 46%, var(--bg-card))',
  'color-mix(in srgb, var(--tool-codex) 32%, var(--bg-card))'
]
function ChartTooltip({ tip }: { tip: ChartTip | null }): React.JSX.Element | null {
  if (!tip) return null
  return (
    <div
      style={{
        position: 'fixed',
        left: tip.x + 12,
        top: tip.y + 12,
        zIndex: 300,
        maxWidth: 240,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--text-primary)',
        color: 'var(--bg-surface)',
        boxShadow: '0 8px 24px rgba(24,24,27,.18)',
        pointerEvents: 'none',
        fontSize: 11.5,
        lineHeight: 1.45
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 3 }}>{tip.title}</div>
      {tip.lines.map((line) => (
        <div key={line} style={{ opacity: 0.82, whiteSpace: 'nowrap' }}>{line}</div>
      ))}
    </div>
  )
}

function StatsHeatmap({ activity }: { activity: StatsActivity }): React.JSX.Element {
  const { t } = useT()
  const map = new Map(activity.days.map((d) => [d.date, d.prompts]))
  const [tip, setTip] = useState<ChartTip | null>(null)
  const WEEKS = 26
  const today = new Date()
  const cols: Array<Array<{ date: string; prompts: number; level: number }>> = []
  for (let w = WEEKS - 1; w >= 0; w--) {
    const col: Array<{ date: string; prompts: number; level: number }> = []
    for (let d = 0; d < 7; d++) {
      const date = new Date(today)
      date.setDate(today.getDate() - (w * 7 + (6 - d)))
      const key = date.toISOString().slice(0, 10)
      const prompts = map.get(key) ?? 0
      col.push({ date: key, prompts, level: heatLevel(prompts) })
    }
    cols.push(col)
  }
  const moveTip = (e: ReactMouseEvent, cell: { date: string; prompts: number }): void => {
    setTip({
      x: e.clientX,
      y: e.clientY,
      title: cell.date,
      lines: [`${humanizeStatsNumber(cell.prompts)} ${t('stats.view.heatCellTip')}`]
    })
  }
  return (
    <div style={{ overflow: 'hidden', width: '100%', position: 'relative' }}>
      <div style={{ display: 'grid', gridTemplateRows: 'repeat(7,14px)', gridAutoFlow: 'column', gridAutoColumns: '14px', gap: 4, width: 'fit-content', maxWidth: '100%' }}>
        {cols.map((col, c) =>
          col.map((cell, r) => (
            <div
              key={`${c}-${r}`}
              onMouseMove={(e) => moveTip(e, cell)}
              onMouseLeave={() => setTip(null)}
              style={{ width: 14, height: 14, borderRadius: 3, background: HEAT_COLORS[cell.level], cursor: 'default' }}
            />
          ))
        )}
      </div>
      <ChartTooltip tip={tip} />
    </div>
  )
}

function RhythmSummary({ activity }: { activity: StatsActivity }): React.JSX.Element {
  const { t } = useT()
  const days = activity.days
  const visibleDays = days.slice(-182)
  const peak = visibleDays.reduce((best, day) => (day.prompts > best.prompts ? day : best), visibleDays[0] ?? { date: '—', prompts: 0 })
  const visibleTotal = visibleDays.reduce((sum, day) => sum + day.prompts, 0)
  const last7 = days.slice(-7).reduce((sum, day) => sum + day.prompts, 0)
  const activeInWindow = visibleDays.filter((day) => day.prompts > 0).length
  const activeRate = visibleDays.length > 0 ? Math.round((activeInWindow / visibleDays.length) * 100) : 0
  const avg = visibleDays.length > 0 ? Math.round(visibleTotal / visibleDays.length) : 0
  const items = [
    { label: t('stats.view.rhythm.peakDay'), value: humanizeStatsNumber(peak.prompts), hint: peak.date },
    { label: t('stats.view.rhythm.last7'), value: humanizeStatsNumber(last7), hint: t('stats.view.rhythm.userPrompts') },
    { label: t('stats.view.rhythm.activeRate'), value: `${activeRate}%`, hint: t('stats.view.rhythm.active26w') },
    { label: t('stats.view.rhythm.dailyAvg'), value: humanizeStatsNumber(avg), hint: t('stats.view.rhythm.userPrompts') }
  ]
  return (
    <div style={{ minWidth: 220, flex: 1, display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', columnGap: 28, rowGap: 18, alignSelf: 'flex-start', paddingTop: 1 }}>
      {items.map((item) => (
        <div key={item.label} style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5, lineHeight: 1 }}>{item.label}</div>
          <div style={{ fontSize: 18, lineHeight: 1.05, color: 'var(--text-primary)', fontWeight: 650, letterSpacing: '-.02em' }}>{item.value}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.hint}</div>
        </div>
      ))}
    </div>
  )
}

function ModelStats({ models: stats }: { models: StatsModels | null }): React.JSX.Element {
  const { t } = useT()
  const [tip, setTip] = useState<ChartTip | null>(null)
  const models = stats?.byModel ?? []
  const visibleModels = models.slice(0, 12)
  const totalTokens = Math.max(1, stats?.tokens.total ?? 0)
  const modelDates = Array.from(new Set((stats?.modelTrend ?? []).map((p) => p.date))).slice(-60)
  const modelRank = new Map(visibleModels.map((model, index) => [model.key, index]))
  const trendByDate = new Map<string, Array<{ model: string; tokens: number }>>()
  for (const point of stats?.modelTrend ?? []) {
    if (!modelRank.has(point.model)) continue
    const bucket = trendByDate.get(point.date) ?? []
    bucket.push(point)
    trendByDate.set(point.date, bucket)
  }
  const maxDayTokens = Math.max(
    1,
    ...modelDates.map((date) => (trendByDate.get(date) ?? []).reduce((sum, point) => sum + point.tokens, 0))
  )
  const moveTip = (e: ReactMouseEvent, date: string, points: Array<{ model: string; tokens: number }>, total: number): void => {
    setTip({
      x: e.clientX,
      y: e.clientY,
      title: date,
      lines: [
        `${humanizeStatsNumber(total)} tokens`,
        ...[...points]
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 6)
          .map((point) => `${point.model}: ${humanizeStatsNumber(point.tokens)}`)
      ]
    })
  }

  if (models.length === 0) {
    return (
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>
        {t('stats.view.noModelData')}
      </div>
    )
  }

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '18px 18px 20px', position: 'relative' }}>
      <div style={{ height: 178, display: 'flex', alignItems: 'flex-end', gap: 3, padding: '8px 4px 0', borderBottom: '1px solid var(--border-subtle)' }}>
        {modelDates.map((date) => {
          const points = (trendByDate.get(date) ?? []).sort((a, b) => (modelRank.get(a.model) ?? 99) - (modelRank.get(b.model) ?? 99))
          const dayTotal = points.reduce((sum, point) => sum + point.tokens, 0)
          return (
            <div
              key={date}
              onMouseMove={(e) => moveTip(e, date, points, dayTotal)}
              onMouseLeave={() => setTip(null)}
              style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: 'default' }}
            >
              <div style={{ width: '100%', height: `${Math.max(1, (dayTotal / maxDayTokens) * 100)}%`, display: 'flex', flexDirection: 'column-reverse', borderRadius: '3px 3px 0 0', overflow: 'hidden' }}>
                {points.map((point) => (
                  <div
                    key={`${date}:${point.model}`}
                    style={{
                      height: `${(point.tokens / dayTotal) * 100}%`,
                      background: MODEL_COLORS[(modelRank.get(point.model) ?? 0) % MODEL_COLORS.length]
                    }}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <ChartTooltip tip={tip} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10.5, color: 'var(--text-muted)' }}>
        <span>{modelDates[0] ?? ''}</span>
        <span>{modelDates.at(-1) ?? ''}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 18 }}>
        {visibleModels.map((model, index) => {
          const pct = (model.tokens.total / totalTokens) * 100
          return (
            <div key={model.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,1fr) 190px 50px', gap: 12, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: MODEL_COLORS[index % MODEL_COLORS.length], flexShrink: 0 }} />
                <span style={{ fontSize: 12.5, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model.label}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                {humanizeStatsNumber(model.tokens.input)} in · {humanizeStatsNumber(model.tokens.output)} out
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right' }}>{pct.toFixed(1)}%</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function StatsView({ statsView }: { statsView: 'stats' | 'growth' }): React.JSX.Element {
  const { t } = useT()
  const [tab, setTab] = useState<'overview' | 'models' | 'projects'>('overview')
  const [range, setRange] = useState<StatsRange>('all')
  const [project, setProject] = useState('')
  const [exporting, setExporting] = useState(false)
  const refreshTimerRef = useRef<number | null>(null)

  const query = useMemo<StatsQuery>(() => ({ range, ...(project ? { workspacePath: project } : {}) }), [range, project])
  const dashboardState = useStatsDashboard(query)
  const modelsState = useStatsModels(query, tab === 'models')
  const summary = dashboardState.data?.summary ?? null
  const activity = dashboardState.data?.activity ?? null

  useEffect(() => {
    const unsubscribe = window.agentOs.events.onMemoryIndexProgress((status) => {
      if (status.building) return
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = window.setTimeout(() => {
        dashboardState.refresh()
        if (tab === 'models') modelsState.refresh()
      }, 700)
    })
    return () => {
      unsubscribe()
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
    }
  }, [dashboardState.refresh, modelsState.refresh, tab])

  if (statsView === 'growth') {
    return <GrowthView />
  }

  const projectOptions = dashboardState.data?.projects ?? []
  const cards = [
    { l: t('stats.view.cards.sessions'), v: summary ? humanizeStatsNumber(summary.sessions) : '—' },
    { l: t('stats.view.cards.messages'), v: summary ? humanizeStatsNumber(summary.prompts) : '—' },
    { l: t('stats.view.cards.tokens'), v: summary ? humanizeStatsNumber(summary.tokens.total) : '—' },
    { l: t('stats.view.cards.activeDays'), v: activity ? String(activity.activeDays) : '—' },
    { l: t('stats.view.cards.currentStreak'), v: activity ? `${activity.currentStreak}d` : '—' },
    { l: t('stats.view.cards.longestStreak'), v: activity ? `${activity.longestStreak}d` : '—' },
    { l: t('stats.view.cards.topCli'), v: summary?.byTool[0]?.label ?? '—' },
    { l: t('stats.view.cards.projects'), v: summary ? String(summary.byProject.length) : '—' }
  ]
  const exportCurrentView = async (): Promise<void> => {
    if (exporting) return
    const view: StatsExportView =
      tab === 'models' ? 'models' : tab === 'projects' ? 'projects' : 'overview'
    setExporting(true)
    try {
      const result = await window.agentOs.stats.exportCsv({ view, query })
      if (!result.cancelled) {
        useNotificationStore.getState().show({
          message: t('stats.export.success'),
          tone: 'success'
        })
      }
    } catch {
      useNotificationStore.getState().show({
        message: t('stats.export.failed'),
        tone: 'error'
      })
    } finally {
      setExporting(false)
    }
  }
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-surface)' }}>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '24px 22px 40px', scrollbarWidth: 'thin' }}>
        <div style={{ maxWidth: 960 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ display: 'flex', background: 'var(--bg-panel)', borderRadius: 8, padding: 2, gap: 1 }}>
            {([
              { v: 'overview', l: t('stats.view.tabOverview') },
              { v: 'models', l: t('stats.view.tabModels') },
              { v: 'projects', l: t('stats.view.tabProjects') }
            ] as const).map(({ v, l }) => (
              <button
                key={v}
                onClick={() => setTab(v)}
                style={{
                  padding: '4px 14px',
                  borderRadius: 6,
                  border: 'none',
                  font: 'inherit',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: tab === v ? 600 : 400,
                  background: tab === v ? 'var(--bg-card)' : 'transparent',
                  color: tab === v ? 'var(--text-primary)' : 'var(--text-muted)',
                  boxShadow: tab === v ? 'var(--shadow-card)' : 'none'
                }}
              >
                {l}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <StatsProjectFilter
            value={project}
            projects={projectOptions}
            onChange={setProject}
          />
          <div style={{ display: 'flex', gap: 1, background: 'var(--bg-panel)', borderRadius: 7, padding: 2 }}>
            {([{ v: 'all', l: 'All' }, { v: '30d', l: '30d' }, { v: '7d', l: '7d' }] as const).map(({ v, l }) => (
              <button
                key={v}
                onClick={() => setRange(v)}
                style={{ height: 24, padding: '0 9px', borderRadius: 5, border: 'none', font: 'inherit', cursor: 'pointer', fontSize: 11.5, fontWeight: range === v ? 600 : 400, background: range === v ? 'var(--bg-card)' : 'transparent', color: range === v ? 'var(--text-primary)' : 'var(--text-muted)' }}
              >
                {l}
              </button>
            ))}
          </div>
          {(dashboardState.refreshing || modelsState.refreshing) && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{t('stats.view.updating')}</div>
          )}
          <Button
            variant="secondary"
            size="sm"
            loading={exporting}
            disabled={!dashboardState.data || (tab === 'models' && !modelsState.data)}
            onClick={() => void exportCurrentView()}
          >
            {t('stats.export.csv')}
          </Button>
        </div>
        {dashboardState.loading && !dashboardState.data && (
          <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>{t('stats.view.loadingStats')}</div>
        )}
        {tab === 'overview' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 10 }}>
              {cards.map((c) => (
                <div key={c.l} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1 }}>{c.l}</div>
                  <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-.02em', lineHeight: 1 }}>{c.v}</div>
                </div>
              ))}
            </div>
            {activity && (
              <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
                  <div style={{ flex: '0 0 auto', minWidth: 0 }}>
                    <StatsHeatmap activity={activity} />
                  </div>
                  <RhythmSummary activity={activity} />
                </div>
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                  {t('stats.view.rhythmSummaryTotal')} <b style={{ color: 'var(--text-secondary)' }}>{humanizeStatsNumber(activity.totalPrompts)}</b> {t('stats.view.rhythmSummaryMid', { days: activity.activeDays })}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'models' && (
          <>
            {modelsState.loading && !modelsState.data && (
              <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>{t('stats.view.loadingModels')}</div>
            )}
            <ModelStats models={modelsState.data} />
          </>
        )}
        {tab === 'projects' && (
          <ProjectStatsView
            projects={summary?.byProject ?? []}
            query={query}
            loading={dashboardState.loading}
          />
        )}
        </div>
      </div>
    </div>
  )
}
