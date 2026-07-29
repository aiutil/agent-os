import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

interface SpawnLock {
  release(): void
}

function removeLock(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // Another process may already have released or reclaimed the lock.
  }
}

function lockIsStale(filePath: string, staleAfterMs: number): boolean {
  try {
    const createdAt = Number(readFileSync(filePath, 'utf8'))
    return !Number.isFinite(createdAt) || Date.now() - createdAt > staleAfterMs
  } catch {
    return true
  }
}

export async function acquireDaemonSpawnLock(
  filePath: string,
  timeoutMs: number
): Promise<SpawnLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      writeFileSync(filePath, String(Date.now()), { flag: 'wx', mode: 0o600 })
      chmodSync(filePath, 0o600)
      return { release: () => removeLock(filePath) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (lockIsStale(filePath, timeoutMs + 1_000)) {
        removeLock(filePath)
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error('等待 daemon 启动锁超时')
}
