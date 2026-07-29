export interface WorkspaceAddProjectBehaviorInput {
  asyncBrowse: boolean
}

export interface WorkspaceMenuStatePatch {
  open: boolean
  clearQuery: boolean
}

export interface RemoteWorkspaceListingEntry {
  path: string
  hidden?: boolean
}

export interface RemoteWorkspaceListingLike {
  hostId?: string
  home: string
  path: string
  parent?: string
  entries: RemoteWorkspaceListingEntry[]
}

export interface RemoteWorkspaceChoicesInput {
  selectedPath?: string
  recentPaths: string[]
  sessionPaths: string[]
  listing?: RemoteWorkspaceListingLike
}

export interface RemoteWorkspaceChoices {
  paths: string[]
  workspacePath: string
}

export function nextWorkspaceMenuStateAfterAddProject(
  input: WorkspaceAddProjectBehaviorInput
): WorkspaceMenuStatePatch {
  return input.asyncBrowse
    ? { open: true, clearQuery: false }
    : { open: false, clearQuery: true }
}

export function buildRemoteWorkspaceChoices(input: RemoteWorkspaceChoicesInput): RemoteWorkspaceChoices {
  if (!input.listing) {
    const paths = uniquePaths([...input.recentPaths, ...input.sessionPaths])
    return { paths, workspacePath: input.selectedPath || paths[0] || '' }
  }

  const defaultPath = input.listing.path || input.listing.home
  const paths = uniquePaths([defaultPath])
  return {
    paths,
    workspacePath: defaultPath
  }
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)))
}
