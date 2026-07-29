import { describe, expect, it } from 'vitest'
import {
  UNASSIGNED_STATS_PROJECT_KEY,
  type StatsProjectOption
} from '../src/shared/types'
import {
  filterStatsProjects,
  projectBasename,
  statsQueryForProject
} from '../src/shared/stats-project-filter'

const PROJECTS: StatsProjectOption[] = [
  { key: '/Users/tester/upwork/agent-os', label: '/Users/tester/upwork/agent-os' },
  { key: '/Users/tester/vkWork/client-web', label: '/Users/tester/vkWork/client-web' },
  { key: 'C:\\work\\DesktopApp', label: 'C:\\work\\DesktopApp' }
]

describe('stats project filter', () => {
  it('extracts readable names from POSIX and Windows paths', () => {
    expect(projectBasename('/Users/tester/upwork/agent-os')).toBe('agent-os')
    expect(projectBasename('C:\\work\\DesktopApp')).toBe('DesktopApp')
  })

  it('matches project basename and full-path fragments case-insensitively', () => {
    expect(filterStatsProjects(PROJECTS, 'AGENT')).toEqual([PROJECTS[0]])
    expect(filterStatsProjects(PROJECTS, 'vkwork/client')).toEqual([PROJECTS[1]])
    expect(filterStatsProjects(PROJECTS, 'desktopapp')).toEqual([PROJECTS[2]])
  })

  it('ignores surrounding whitespace and preserves source order', () => {
    expect(filterStatsProjects(PROJECTS, '  /Users/tester  ')).toEqual(PROJECTS.slice(0, 2))
    expect(filterStatsProjects(PROJECTS, '   ')).toEqual(PROJECTS)
  })

  it('returns an empty result when no project matches', () => {
    expect(filterStatsProjects(PROJECTS, 'not-a-project')).toEqual([])
  })

  it('builds mutually exclusive project and unassigned-workspace queries', () => {
    expect(
      statsQueryForProject(
        {
          range: '30d',
          toolIds: ['codex'],
          workspacePath: '/stale',
          unassignedWorkspace: true
        },
        '/workspace/current'
      )
    ).toEqual({
      range: '30d',
      toolIds: ['codex'],
      workspacePath: '/workspace/current'
    })
    expect(
      statsQueryForProject(
        { range: '7d', toolIds: ['claude'], workspacePath: '/stale' },
        UNASSIGNED_STATS_PROJECT_KEY
      )
    ).toEqual({
      range: '7d',
      toolIds: ['claude'],
      unassignedWorkspace: true
    })
  })
})
