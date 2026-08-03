import type { RemoteNodeStatus } from './types'

export function remoteRuntimeHostId(runtimeHostId?: string): string | undefined {
  return runtimeHostId && runtimeHostId !== 'local' ? runtimeHostId : undefined
}

export function sessionProjectGroupKey(workspacePath: string, runtimeHostId?: string): string {
  return `${remoteRuntimeHostId(runtimeHostId) ?? 'local'}\0${workspacePath}`
}

export function remoteNodeTipLabel(
  runtimeHostId: string | undefined,
  statuses: RemoteNodeStatus[],
  fallback: string
): string | null {
  const remoteHostId = remoteRuntimeHostId(runtimeHostId)
  if (!remoteHostId) return null
  return statuses.find((status) => status.id === remoteHostId)?.label || fallback
}
