import type { CliHealth, DiscoveryResult, RuntimeInfo } from './types'

export function isUsableCliHealth(health: CliHealth): boolean {
  return health === 'ready' || health === 'updatable'
}

export function filterUsableDiscoveryResults(results: DiscoveryResult[]): DiscoveryResult[] {
  return results.filter((result) => isUsableCliHealth(result.health))
}

export function filterUsableRuntimes(runtimes: RuntimeInfo[]): RuntimeInfo[] {
  return runtimes.filter((runtime) => isUsableCliHealth(runtime.health))
}
