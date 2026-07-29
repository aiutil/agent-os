import type {
  StatsBreakdownItem,
  StatsDashboard,
  StatsExportCsvInput,
  StatsModels,
  StatsQuery,
  StatsSummary
} from '@shared/types'
import { UNASSIGNED_STATS_PROJECT_KEY } from '@shared/types'
import { statsQueryForProject } from '@shared/stats-project-filter'

const COLUMNS = [
  'section',
  'key',
  'label',
  'date',
  'sessions',
  'prompts',
  'input_tokens',
  'output_tokens',
  'cache_write_tokens',
  'cache_read_tokens',
  'total_tokens',
  'estimated_cost_usd',
  'has_unpriced_usage',
  'value'
] as const

type Column = (typeof COLUMNS)[number]
type CsvValue = string | number | boolean | null | undefined
type CsvRow = Partial<Record<Column, CsvValue>>

export interface StatsExportSource {
  statsDashboard(input: StatsQuery): Promise<StatsDashboard>
  statsModels(input: StatsQuery): Promise<StatsModels>
  statsSummary(input: StatsQuery): Promise<StatsSummary>
}

export interface StatsCsvArtifact {
  content: string
  defaultFileName: string
}

function metadataRows(input: StatsExportCsvInput): CsvRow[] {
  const selectedProject =
    input.view === 'project' ? input.projectPath : input.query.workspacePath
  return [
    { section: 'metadata', key: 'view', value: input.view },
    { section: 'metadata', key: 'range', value: input.query.range },
    {
      section: 'metadata',
      key: 'workspace_path',
      value:
        selectedProject === UNASSIGNED_STATS_PROJECT_KEY
          ? ''
          : selectedProject
    },
    {
      section: 'metadata',
      key: 'unassigned_workspace',
      value:
        selectedProject === UNASSIGNED_STATS_PROJECT_KEY ||
        input.query.unassignedWorkspace === true
    },
    {
      section: 'metadata',
      key: 'tool_ids',
      value: input.query.toolIds?.join('|') ?? ''
    }
  ]
}

function summaryRows(summary: StatsSummary | StatsDashboard['summary']): CsvRow[] {
  return [
    { section: 'summary', key: 'sessions', value: summary.sessions },
    { section: 'summary', key: 'prompts', value: summary.prompts },
    { section: 'summary', key: 'input_tokens', value: summary.tokens.input },
    { section: 'summary', key: 'output_tokens', value: summary.tokens.output },
    { section: 'summary', key: 'cache_write_tokens', value: summary.tokens.cacheWrite },
    { section: 'summary', key: 'cache_read_tokens', value: summary.tokens.cacheRead },
    { section: 'summary', key: 'total_tokens', value: summary.tokens.total },
    {
      section: 'summary',
      key: 'estimated_cost_usd',
      value: summary.estimatedCostUsd
    },
    {
      section: 'summary',
      key: 'has_unpriced_usage',
      value: summary.hasUnpricedUsage
    }
  ]
}

function breakdownRows(section: string, items: StatsBreakdownItem[]): CsvRow[] {
  return items.map((item) => ({
    section,
    key: item.key,
    label: item.label,
    sessions: item.sessions,
    prompts: item.prompts,
    total_tokens: item.tokens,
    estimated_cost_usd: item.estimatedCostUsd,
    has_unpriced_usage: item.hasUnpricedUsage
  }))
}

function modelRows(models: StatsModels | StatsSummary): CsvRow[] {
  return models.byModel.map((model) => ({
    section: 'model',
    key: model.key,
    label: model.label,
    sessions: model.sessions,
    input_tokens: model.tokens.input,
    output_tokens: model.tokens.output,
    cache_write_tokens: model.tokens.cacheWrite,
    cache_read_tokens: model.tokens.cacheRead,
    total_tokens: model.tokens.total,
    estimated_cost_usd: model.estimatedCostUsd,
    has_unpriced_usage: model.hasUnpricedUsage
  }))
}

function normalizeTextForSpreadsheet(value: string): string {
  const firstNonWhitespace = value.trimStart().charAt(0)
  return /^[=+\-@]$/.test(firstNonWhitespace) ? `'${value}` : value
}

function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return ''
  const normalized =
    typeof value === 'string' ? normalizeTextForSpreadsheet(value) : String(value)
  return `"${normalized.replace(/"/g, '""')}"`
}

function serializeRows(rows: CsvRow[]): string {
  const header = COLUMNS.join(',')
  const body = rows.map((row) => COLUMNS.map((column) => csvCell(row[column])).join(','))
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`
}

function safeFilePart(value: string): string {
  return value
    .split(/[/\\]/)
    .filter(Boolean)
    .at(-1)
    ?.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project'
}

function defaultFileName(input: StatsExportCsvInput, now: Date): string {
  const date = now.toISOString().slice(0, 10)
  const project =
    input.view === 'project' && input.projectPath
      ? input.projectPath === UNASSIGNED_STATS_PROJECT_KEY
        ? '-unassigned-project'
        : `-${safeFilePart(input.projectPath)}`
      : ''
  return `Agent-OS-stats-${input.view}${project}-${input.query.range}-${date}.csv`
}

export async function buildStatsCsvArtifact(
  input: StatsExportCsvInput,
  source: StatsExportSource,
  now = new Date()
): Promise<StatsCsvArtifact> {
  const rows = metadataRows(input)

  if (input.view === 'overview') {
    const dashboard = await source.statsDashboard(input.query)
    rows.push(
      ...summaryRows(dashboard.summary),
      ...breakdownRows('tool', dashboard.summary.byTool),
      ...breakdownRows('project', dashboard.summary.byProject),
      {
        section: 'activity_summary',
        key: 'active_days',
        value: dashboard.activity.activeDays
      },
      {
        section: 'activity_summary',
        key: 'current_streak',
        value: dashboard.activity.currentStreak
      },
      {
        section: 'activity_summary',
        key: 'longest_streak',
        value: dashboard.activity.longestStreak
      },
      {
        section: 'activity_summary',
        key: 'total_prompts',
        value: dashboard.activity.totalPrompts
      },
      ...dashboard.activity.days.map((day) => ({
        section: 'activity',
        date: day.date,
        prompts: day.prompts
      }))
    )
  } else if (input.view === 'models') {
    const models = await source.statsModels(input.query)
    rows.push(
      { section: 'summary', key: 'input_tokens', value: models.tokens.input },
      { section: 'summary', key: 'output_tokens', value: models.tokens.output },
      { section: 'summary', key: 'cache_write_tokens', value: models.tokens.cacheWrite },
      { section: 'summary', key: 'cache_read_tokens', value: models.tokens.cacheRead },
      { section: 'summary', key: 'total_tokens', value: models.tokens.total },
      ...modelRows(models),
      ...models.modelTrend.map((point) => ({
        section: 'model_trend',
        key: point.model,
        date: point.date,
        total_tokens: point.tokens
      }))
    )
  } else if (input.view === 'projects') {
    const dashboard = await source.statsDashboard(input.query)
    rows.push(...breakdownRows('project', dashboard.summary.byProject))
  } else {
    const projectPath = input.projectPath?.trim()
    if (!projectPath) throw new Error('projectPath is required for project stats export')
    const summary = await source.statsSummary(statsQueryForProject(input.query, projectPath))
    rows.push(
      ...summaryRows(summary),
      ...breakdownRows('tool', summary.byTool),
      ...modelRows(summary),
      ...summary.trend.map((point) => ({
        section: 'token_trend',
        date: point.date,
        prompts: point.prompts,
        total_tokens: point.tokens,
        estimated_cost_usd: point.estimatedCostUsd
      }))
    )
  }

  return {
    content: serializeRows(rows),
    defaultFileName: defaultFileName(input, now)
  }
}
