import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface PendingCrashSignal {
  crashKind:
    | 'main-uncaught-exception'
    | 'main-unhandled-rejection'
    | 'renderer-process-gone'
    | 'child-process-gone'
  processType: 'main' | 'renderer' | 'child'
  appVersion: string
}

const CRASH_KINDS = new Set<PendingCrashSignal['crashKind']>([
  'main-uncaught-exception',
  'main-unhandled-rejection',
  'renderer-process-gone',
  'child-process-gone'
])
const SAFE_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i

function writePrivateJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
  chmodSync(file, 0o600)
}

export function writePendingCrashSignal(file: string, signal: PendingCrashSignal): void {
  writePrivateJson(file, signal)
}

export function consumePendingCrashSignal(file: string): PendingCrashSignal | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PendingCrashSignal>
    rmSync(file, { force: true })
    if (
      typeof parsed.crashKind !== 'string' ||
      !CRASH_KINDS.has(parsed.crashKind as PendingCrashSignal['crashKind']) ||
      !['main', 'renderer', 'child'].includes(parsed.processType ?? '') ||
      typeof parsed.appVersion !== 'string' ||
      !SAFE_VERSION.test(parsed.appVersion)
    )
      return null
    return parsed as PendingCrashSignal
  } catch {
    rmSync(file, { force: true })
    return null
  }
}

export function recordVersionUpgrade(
  file: string,
  currentVersion: string
): { fromVersion: string; toVersion: string } | null {
  let previous = ''
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    if (typeof parsed.version === 'string' && SAFE_VERSION.test(parsed.version)) {
      previous = parsed.version
    }
  } catch {
    // 首次启动或旧文件损坏：只播种当前版本，不产生虚假升级事件。
  }
  writePrivateJson(file, { version: currentVersion })
  return previous && previous !== currentVersion
    ? { fromVersion: previous, toVersion: currentVersion }
    : null
}
