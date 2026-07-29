import {
  UNASSIGNED_STATS_PROJECT_KEY,
  type StatsProjectOption,
  type StatsQuery
} from './types'

export function projectBasename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts.at(-1) ?? path
}

export function filterStatsProjects(
  projects: StatsProjectOption[],
  query: string
): StatsProjectOption[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return projects

  return projects.filter((project) =>
    [project.key, project.label, projectBasename(project.label || project.key)]
      .some((value) => value.toLowerCase().includes(normalized))
  )
}

export function statsQueryForProject(query: StatsQuery, projectKey: string): StatsQuery {
  const base: StatsQuery = {
    range: query.range,
    ...(query.toolIds?.length ? { toolIds: query.toolIds } : {})
  }
  return projectKey === UNASSIGNED_STATS_PROJECT_KEY
    ? { ...base, unassignedWorkspace: true }
    : { ...base, workspacePath: projectKey }
}
