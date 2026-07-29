import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listRuntimeDirectories } from '../src/main/domains/runtime/directory-browser'

describe('listRuntimeDirectories', () => {
  it('lists directories for the target host without returning files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-os-dirs-'))
    await mkdir(join(root, 'project-a'))
    await mkdir(join(root, '.hidden-project'))
    await writeFile(join(root, 'README.md'), 'not a directory')

    const listing = await listRuntimeDirectories({ hostId: 'remote-a', path: root })

    expect(listing.hostId).toBe('remote-a')
    expect(listing.path).toBe(root)
    expect(listing.entries.map((entry) => entry.name)).toEqual(['project-a', '.hidden-project'])
    expect(listing.entries.some((entry) => entry.name === 'README.md')).toBe(false)
    expect(listing.parent).toBeTruthy()
  })

  it('rejects non-directory paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-os-dirs-'))
    const file = join(root, 'file.txt')
    await writeFile(file, 'x')

    await expect(listRuntimeDirectories({ path: file })).rejects.toThrow('不是目录')
  })
})
