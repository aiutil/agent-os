import { describe, expect, it, vi } from 'vitest'
import type {
  StatsDashboard,
  StatsModels,
  StatsQuery,
  StatsSummary
} from '../src/shared/types'
import { UNASSIGNED_STATS_PROJECT_KEY } from '../src/shared/types'
import {
  buildStatsCsvArtifact,
  type StatsExportSource
} from '../src/main/domains/stats/export'

const TOKENS = {
  input: 100,
  output: 40,
  cacheWrite: 10,
  cacheRead: 5,
  total: 155
}

const PROJECT = {
  key: '/Users/test/work/agent-os',
  label: '/Users/test/work/agent-os',
  sessions: 2,
  prompts: 7,
  tokens: 155,
  estimatedCostUsd: 0.25,
  hasUnpricedUsage: false
}

const DASHBOARD: StatsDashboard = {
  summary: {
    sessions: 2,
    prompts: 7,
    tokens: TOKENS,
    estimatedCostUsd: 0.25,
    hasUnpricedUsage: false,
    byTool: [{ ...PROJECT, key: 'codex', label: 'Codex' }],
    byProject: [PROJECT]
  },
  activity: {
    days: [{ date: '2026-07-24', prompts: 7 }],
    activeDays: 1,
    currentStreak: 1,
    longestStreak: 1,
    totalPrompts: 7,
    byTool: []
  },
  projects: [{ key: PROJECT.key, label: PROJECT.label }]
}

const MODELS: StatsModels = {
  tokens: TOKENS,
  byModel: [
    {
      key: 'gpt-5',
      label: 'gpt-5',
      sessions: 2,
      facts: 3,
      tokens: TOKENS,
      estimatedCostUsd: null,
      hasUnpricedUsage: true
    }
  ],
  modelTrend: [{ date: '2026-07-24', model: 'gpt-5', tokens: 155 }]
}

const SUMMARY: StatsSummary = {
  ...DASHBOARD.summary,
  byModel: MODELS.byModel,
  modelTrend: MODELS.modelTrend,
  trend: [
    { date: '2026-07-23', prompts: 0, tokens: 55, estimatedCostUsd: 0.1 },
    { date: '2026-07-24', prompts: 0, tokens: 100, estimatedCostUsd: 0.15 }
  ]
}

function source(): StatsExportSource {
  return {
    statsDashboard: vi.fn(async () => DASHBOARD),
    statsModels: vi.fn(async () => MODELS),
    statsSummary: vi.fn(async () => SUMMARY)
  }
}

const QUERY: StatsQuery = { range: '30d' }

describe('stats CSV export', () => {
  it('exports overview metadata, summary, grouped data, and daily activity', async () => {
    const artifact = await buildStatsCsvArtifact(
      { view: 'overview', query: QUERY },
      source(),
      new Date('2026-07-24T00:00:00.000Z')
    )

    expect(artifact.content.startsWith('\uFEFFsection,key,label')).toBe(true)
    expect(artifact.content).toContain('"metadata","range"')
    expect(artifact.content).toContain('"tool","codex","Codex"')
    expect(artifact.content).toContain('"project","/Users/test/work/agent-os"')
    expect(artifact.content).toContain('"activity_summary","active_days"')
    expect(artifact.content).toContain('"activity_summary","current_streak"')
    expect(artifact.content).toContain('"activity_summary","longest_streak"')
    expect(artifact.content).toContain('"activity_summary","total_prompts"')
    expect(artifact.content).toContain('"activity",,,"2026-07-24"')
    expect(artifact.defaultFileName).toBe('Agent-OS-stats-overview-30d-2026-07-24.csv')
  })

  it('exports model breakdown and daily model trend', async () => {
    const artifact = await buildStatsCsvArtifact(
      { view: 'models', query: QUERY },
      source()
    )

    expect(artifact.content).toContain('"model","gpt-5","gpt-5"')
    expect(artifact.content).toContain('"model_trend","gpt-5",,"2026-07-24"')
  })

  it('exports only grouped project rows for the projects view and protects formulas', async () => {
    const formulaDashboard: StatsDashboard = {
      ...DASHBOARD,
      summary: {
        ...DASHBOARD.summary,
        byProject: [
          {
            ...PROJECT,
            key: '=HYPERLINK("bad")',
            label: '+formula,project'
          }
        ]
      }
    }
    const exportSource = source()
    exportSource.statsDashboard = vi.fn(async () => formulaDashboard)

    const artifact = await buildStatsCsvArtifact(
      { view: 'projects', query: QUERY },
      exportSource
    )

    expect(artifact.content).toContain(`"'=HYPERLINK(""bad"")"`)
    expect(artifact.content).toContain(`"'+formula,project"`)
    expect(artifact.content).not.toContain('"activity"')
  })

  it('overrides workspace filtering for project detail and exports its trend', async () => {
    const exportSource = source()
    const artifact = await buildStatsCsvArtifact(
      {
        view: 'project',
        query: { range: '7d', workspacePath: '/stale/path' },
        projectPath: '/Users/test/work/project:name'
      },
      exportSource,
      new Date('2026-07-24T00:00:00.000Z')
    )

    expect(exportSource.statsSummary).toHaveBeenCalledWith({
      range: '7d',
      workspacePath: '/Users/test/work/project:name'
    })
    expect(artifact.content).toContain('"token_trend",,,"2026-07-23"')
    expect(artifact.defaultFileName).toBe(
      'Agent-OS-stats-project-project-name-7d-2026-07-24.csv'
    )
  })

  it('rejects project export without a project path', async () => {
    await expect(
      buildStatsCsvArtifact({ view: 'project', query: QUERY }, source())
    ).rejects.toThrow('projectPath is required')
  })

  it('exports unassigned project detail with the explicit null-workspace filter', async () => {
    const exportSource = source()
    const artifact = await buildStatsCsvArtifact(
      {
        view: 'project',
        query: { range: '30d', workspacePath: '/stale/path' },
        projectPath: UNASSIGNED_STATS_PROJECT_KEY
      },
      exportSource,
      new Date('2026-07-24T00:00:00.000Z')
    )

    expect(exportSource.statsSummary).toHaveBeenCalledWith({
      range: '30d',
      unassignedWorkspace: true
    })
    expect(artifact.content).toContain('"metadata","unassigned_workspace"')
    expect(artifact.defaultFileName).toBe(
      'Agent-OS-stats-project-unassigned-project-30d-2026-07-24.csv'
    )
  })
})
