import type { NodeAgentInfo } from './types'

export interface RemoteAgentCatalogItem {
  toolId: string
  displayName: string
}

export function buildRemoteAgentTiles(
  agents: NodeAgentInfo[],
  catalog: RemoteAgentCatalogItem[]
): RemoteAgentCatalogItem[] {
  const catalogNames = new Map(catalog.map((item) => [item.toolId, item.displayName]))
  return agents.map((agent) => ({
    toolId: agent.id,
    displayName: agent.alias || catalogNames.get(agent.id) || agent.name
  }))
}
