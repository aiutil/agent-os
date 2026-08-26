import { describe, expect, it, vi } from 'vitest'
import { openLocalDirectory } from '../src/main/domains/sessions/open-directory'

describe('open session project directory', () => {
  it('opens only an existing absolute directory', async () => {
    const openPath = vi.fn(async () => '')

    await openLocalDirectory(process.cwd(), openPath)
    expect(openPath).toHaveBeenCalledWith(process.cwd())
    await expect(openLocalDirectory('relative/project', openPath)).rejects.toThrow('absolute path')
    await expect(openLocalDirectory(process.execPath, openPath)).rejects.toThrow('does not exist')
  })
})
