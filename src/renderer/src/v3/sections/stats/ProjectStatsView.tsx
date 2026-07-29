import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { StatsBreakdownItem, StatsQuery, StatsSummary, StatsTrendPoint } from '@shared/types'
import { UNASSIGNED_STATS_PROJECT_KEY } from '@shared/types'
import { projectBasename, statsQueryForProject } from '@shared/stats-project-filter'
import { useT } from '../../../lib/i18n'
import { Button, Modal } from '../../../lib/ui'
import { useNotificationStore } from '../../../stores/notificationStore'
import { formatEstimatedCost, humanizeStatsNumber } from './stats-format'

interface TrendTip {
  x: number
  y: number
  point: StatsTrendPoint
}

function ProjectTokenTrend({
  points
}: {
  points: StatsTrendPoint[]
}): React.JSX.Element {
  const { t } = useT()
  const [tip, setTip] = useState<TrendTip | null>(null)
  const width = 680
  const height = 230
  const padding = { top: 18, right: 18, bottom: 30, left: 58 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const maxTokens = Math.max(1, ...points.map((point) => point.tokens))
  const xFor = (index: number): number =>
    points.length <= 1
      ? padding.left + chartWidth / 2
      : padding.left + (index / (points.length - 1)) * chartWidth
  const yFor = (tokens: number): number =>
    padding.top + chartHeight - (tokens / maxTokens) * chartHeight
  const linePoints = points
    .map((point, index) => `${xFor(index)},${yFor(point.tokens)}`)
    .join(' ')
  const areaPoints =
    points.length > 0
      ? `${padding.left},${padding.top + chartHeight} ${linePoints} ${xFor(points.length - 1)},${padding.top + chartHeight}`
      : ''

  if (points.length === 0) {
    return (
      <div
        style={{
          minHeight: 220,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          background: 'var(--bg-panel)',
          color: 'var(--text-muted)',
          fontSize: 12
        }}
      >
        {t('stats.project.noTrend')}
      </div>
    )
  }

  const moveTip = (event: ReactMouseEvent<SVGGElement>, point: StatsTrendPoint): void => {
    setTip({ x: event.clientX, y: event.clientY, point })
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('stats.project.trendAria')}
        style={{ display: 'block', width: '100%', minHeight: 230 }}
      >
        {[0, 0.5, 1].map((ratio) => {
          const y = padding.top + chartHeight * ratio
          const value = Math.round(maxTokens * (1 - ratio))
          return (
            <g key={ratio}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke="var(--border-subtle)"
                strokeWidth="1"
              />
              <text
                x={padding.left - 10}
                y={y + 4}
                textAnchor="end"
                fill="var(--text-muted)"
                fontSize="10"
              >
                {humanizeStatsNumber(value)}
              </text>
            </g>
          )
        })}
        <polygon points={areaPoints} fill="var(--accent-soft)" opacity="0.72" />
        <polyline
          points={linePoints}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map((point, index) => (
          <g
            key={`${point.date}:${index}`}
            onMouseMove={(event) => moveTip(event, point)}
            onMouseLeave={() => setTip(null)}
            style={{ cursor: 'default' }}
          >
            <circle cx={xFor(index)} cy={yFor(point.tokens)} r="9" fill="transparent" />
            <circle
              cx={xFor(index)}
              cy={yFor(point.tokens)}
              r="3"
              fill="var(--bg-card)"
              stroke="var(--accent)"
              strokeWidth="1.5"
            />
          </g>
        ))}
        <text
          x={padding.left}
          y={height - 7}
          textAnchor="start"
          fill="var(--text-muted)"
          fontSize="10"
        >
          {points[0]?.date}
        </text>
        <text
          x={width - padding.right}
          y={height - 7}
          textAnchor="end"
          fill="var(--text-muted)"
          fontSize="10"
        >
          {points.at(-1)?.date}
        </text>
      </svg>
      {tip && (
        <div
          style={{
            position: 'fixed',
            left: tip.x + 12,
            top: tip.y + 12,
            zIndex: 60,
            padding: '7px 9px',
            borderRadius: 7,
            background: 'var(--text-primary)',
            color: 'var(--bg-card)',
            boxShadow: 'var(--shadow-pop)',
            pointerEvents: 'none',
            fontSize: 11,
            lineHeight: 1.45
          }}
        >
          <div style={{ fontWeight: 650 }}>{tip.point.date}</div>
          <div>{humanizeStatsNumber(tip.point.tokens)} tokens</div>
        </div>
      )}
    </div>
  )
}

function MetricCard({
  label,
  value
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div
      style={{
        minWidth: 0,
        padding: '10px 12px',
        border: '1px solid var(--border-subtle)',
        borderRadius: 9,
        background: 'var(--bg-panel)'
      }}
    >
      <div style={{ marginBottom: 5, color: 'var(--text-muted)', fontSize: 10.5 }}>{label}</div>
      <div
        style={{
          color: 'var(--text-primary)',
          fontSize: 17,
          fontWeight: 650,
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {value}
      </div>
    </div>
  )
}

export function ProjectStatsView({
  projects,
  query,
  loading
}: {
  projects: StatsBreakdownItem[]
  query: StatsQuery
  loading: boolean
}): React.JSX.Element {
  const { t } = useT()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [detail, setDetail] = useState<StatsSummary | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const [exporting, setExporting] = useState(false)
  const projectName = (project: StatsBreakdownItem | string): string => {
    const key = typeof project === 'string' ? project : project.key
    if (key === UNASSIGNED_STATS_PROJECT_KEY) return t('stats.project.unassigned')
    const label = typeof project === 'string' ? project : project.label || project.key
    return projectBasename(label)
  }
  const projectPathLabel = (projectKey: string): string =>
    projectKey === UNASSIGNED_STATS_PROJECT_KEY
      ? t('stats.project.noWorkspacePath')
      : projectKey

  useEffect(() => {
    if (!selectedPath) {
      setDetail(null)
      setDetailLoading(false)
      setDetailError(false)
      return
    }
    let active = true
    setDetail(null)
    setDetailError(false)
    setDetailLoading(true)
    void window.agentOs.stats
      .summary(statsQueryForProject(query, selectedPath))
      .then((summary) => {
        if (active) setDetail(summary)
      })
      .catch(() => {
        if (active) setDetailError(true)
      })
      .finally(() => {
        if (active) setDetailLoading(false)
      })
    return () => {
      active = false
    }
  }, [query, selectedPath])

  const exportProject = async (): Promise<void> => {
    if (!selectedPath || exporting) return
    setExporting(true)
    try {
      const result = await window.agentOs.stats.exportCsv({
        view: 'project',
        query,
        projectPath: selectedPath
      })
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

  if (loading && projects.length === 0) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>
        {t('stats.project.loading')}
      </div>
    )
  }

  return (
    <>
      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          background: 'var(--bg-panel)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(220px,1.5fr) 58px 58px 82px 72px 16px',
            gap: 10,
            alignItems: 'center',
            padding: '9px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            color: 'var(--text-muted)',
            fontSize: 10.5,
            fontWeight: 600
          }}
        >
          <span>{t('stats.project.columns.project')}</span>
          <span style={{ textAlign: 'right' }}>{t('stats.project.columns.sessions')}</span>
          <span style={{ textAlign: 'right' }}>{t('stats.project.columns.prompts')}</span>
          <span style={{ textAlign: 'right' }}>{t('stats.project.columns.tokens')}</span>
          <span style={{ textAlign: 'right' }}>{t('stats.project.columns.cost')}</span>
          <span aria-hidden="true" />
        </div>
        {projects.map((project) => (
          <button
            type="button"
            key={project.key}
            onClick={() => setSelectedPath(project.key)}
            aria-label={t('stats.project.openDetail', {
              project: projectName(project)
            })}
            style={{
              width: '100%',
              display: 'grid',
              gridTemplateColumns: 'minmax(220px,1.5fr) 58px 58px 82px 72px 16px',
              gap: 10,
              alignItems: 'center',
              padding: '10px 12px',
              border: 'none',
              borderBottom: '1px solid var(--border-subtle)',
              background: 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              font: 'inherit',
              textAlign: 'left'
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', marginBottom: 3, fontSize: 12.5, fontWeight: 650 }}>
                {projectName(project)}
              </span>
              <span
                style={{
                  display: 'block',
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  lineHeight: 1.35,
                  overflowWrap: 'anywhere',
                  userSelect: 'text'
                }}
              >
                {projectPathLabel(project.key)}
              </span>
            </span>
            <span style={{ textAlign: 'right', fontSize: 11.5 }}>{project.sessions}</span>
            <span style={{ textAlign: 'right', fontSize: 11.5 }}>{project.prompts}</span>
            <span style={{ textAlign: 'right', fontSize: 11.5, fontWeight: 600 }}>
              {humanizeStatsNumber(project.tokens)}
            </span>
            <span style={{ textAlign: 'right', fontSize: 11 }}>
              {formatEstimatedCost(project.estimatedCostUsd, project.hasUnpricedUsage)}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 16 }} aria-hidden="true">
              ›
            </span>
          </button>
        ))}
        {projects.length === 0 && (
          <div
            style={{
              padding: '28px 16px',
              color: 'var(--text-muted)',
              fontSize: 12,
              textAlign: 'center'
            }}
          >
            {t('stats.project.empty')}
          </div>
        )}
      </div>

      <Modal
        open={Boolean(selectedPath)}
        onClose={() => setSelectedPath(null)}
        title={
          <div style={{ minWidth: 0 }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedPath ? projectName(selectedPath) : ''}
            </div>
            <div
              style={{
                marginTop: 3,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                fontWeight: 400,
                overflowWrap: 'anywhere'
              }}
            >
              {selectedPath ? projectPathLabel(selectedPath) : ''}
            </div>
          </div>
        }
        size="lg"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSelectedPath(null)}>
              {t('common.action.close')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={exporting}
              disabled={!detail}
              onClick={() => void exportProject()}
            >
              {t('stats.export.csv')}
            </Button>
          </>
        }
      >
        {detailLoading && (
          <div style={{ minHeight: 260, color: 'var(--text-muted)', fontSize: 12 }}>
            {t('stats.project.loadingDetail')}
          </div>
        )}
        {detailError && !detailLoading && (
          <div
            role="alert"
            style={{
              minHeight: 220,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--danger)',
              fontSize: 12
            }}
          >
            {t('stats.project.loadFailed')}
          </div>
        )}
        {detail && !detailLoading && (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4,minmax(0,1fr))',
                gap: 8,
                marginBottom: 16
              }}
            >
              <MetricCard
                label={t('stats.project.columns.sessions')}
                value={humanizeStatsNumber(detail.sessions)}
              />
              <MetricCard
                label={t('stats.project.columns.prompts')}
                value={humanizeStatsNumber(detail.prompts)}
              />
              <MetricCard
                label={t('stats.project.columns.tokens')}
                value={humanizeStatsNumber(detail.tokens.total)}
              />
              <MetricCard
                label={t('stats.project.columns.cost')}
                value={formatEstimatedCost(
                  detail.estimatedCostUsd,
                  detail.hasUnpricedUsage
                )}
              />
            </div>
            <div
              style={{
                marginBottom: 8,
                color: 'var(--text-primary)',
                fontSize: 12.5,
                fontWeight: 650
              }}
            >
              {t('stats.project.tokenTrend')}
            </div>
            <ProjectTokenTrend points={detail.trend} />
          </>
        )}
      </Modal>
    </>
  )
}
