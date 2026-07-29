import { readFileSync } from 'node:fs'
import type { ProviderConfig } from '@shared/types'
import { getAdapter } from '../adapters/registry'
import { buildProviderEnvironment } from '../lifecycle/config'

interface PersistedAppStore {
  providerConfigs?: Record<string, ProviderConfig>
}

function readProvider(storeFile: string, toolId: string): ProviderConfig {
  try {
    const store = JSON.parse(readFileSync(storeFile, 'utf8')) as PersistedAppStore
    return store.providerConfigs?.[toolId] ?? { toolId }
  } catch {
    return { toolId }
  }
}

export function createFileProviderConfig(storeFile: string): {
  environment(toolId: string): Record<string, string>
  model(toolId: string): string | undefined
} {
  return {
    environment(toolId) {
      const adapter = getAdapter(toolId)
      return adapter
        ? buildProviderEnvironment(adapter, readProvider(storeFile, toolId))
        : {}
    },
    model(toolId) {
      return readProvider(storeFile, toolId).model
    }
  }
}
