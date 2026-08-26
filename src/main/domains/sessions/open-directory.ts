import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export async function openLocalDirectory(
  input: string,
  openPath: (path: string) => Promise<string>
): Promise<void> {
  const path = input.trim()
  if (!path || !isAbsolute(path)) throw new Error('Project directory must be an absolute path')

  const target = resolve(path)
  try {
    if (!statSync(target).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('Project directory does not exist or is not accessible')
  }

  const error = await openPath(target)
  if (error) throw new Error(error)
}
