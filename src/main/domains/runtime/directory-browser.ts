import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import type {
  ListRuntimeDirectoriesInput,
  RuntimeDirectoryEntry,
  RuntimeDirectoryListing
} from '@shared/types'

const DEFAULT_LIMIT = 80
const MAX_LIMIT = 200

function normalizePath(path?: string): string {
  const home = homedir()
  const trimmed = path?.trim()
  if (!trimmed || trimmed === '~') return home
  if (trimmed.startsWith('~/')) return resolve(home, trimmed.slice(2))
  return resolve(trimmed)
}

export async function listRuntimeDirectories(
  input: ListRuntimeDirectoriesInput = {}
): Promise<RuntimeDirectoryListing> {
  const home = homedir()
  const target = normalizePath(input.path)
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const stat = await fs.stat(target)
  if (!stat.isDirectory()) throw new Error(`不是目录：${target}`)
  const dirents = await fs.readdir(target, { withFileTypes: true })
  const entries: RuntimeDirectoryEntry[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const name = dirent.name
    entries.push({
      name,
      path: resolve(target, name),
      hidden: name.startsWith('.')
    })
  }
  entries.sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1
    return a.name.localeCompare(b.name)
  })
  const parent = dirname(target)
  return {
    hostId: input.hostId,
    path: target,
    home,
    ...(parent && parent !== target ? { parent } : {}),
    entries: entries.slice(0, limit)
  }
}
