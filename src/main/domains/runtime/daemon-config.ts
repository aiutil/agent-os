import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { RuntimeHostStatus } from '@shared/types'

export interface DaemonConfig {
  token: string
  protocolVersion: number
  hostVersion: string
  runtimeBuildId: string
  sessionsFile: string
  tasksFile?: string
  chatStoreFile: string
  providerStoreFile: string
  pid?: number
  port?: number
  startedAt?: string
}

export function readDaemonConfig(filePath: string): DaemonConfig | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as DaemonConfig
  } catch {
    return null
  }
}

export function writeDaemonConfig(filePath: string, config: DaemonConfig): void {
  const temporary = `${filePath}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, filePath)
  chmodSync(filePath, 0o600)
}

export function runtimeBuildIdFor(entryPath: string, fallback: string): string {
  try {
    const stat = statSync(entryPath)
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}`
  } catch {
    return fallback
  }
}

export function degradedStatus(
  hostVersion: string,
  runtimeBuildId: string,
  protocolVersion: number,
  sessionCount: number,
  fallbackReason: string
): RuntimeHostStatus {
  return {
    mode: 'in-process',
    connection: 'degraded',
    protocolVersion,
    hostVersion,
    runtimeBuildId,
    sessionCount,
    fallbackReason
  }
}
