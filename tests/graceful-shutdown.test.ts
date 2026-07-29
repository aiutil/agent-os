import { describe, expect, it, vi } from 'vitest'
import { createGracefulBeforeQuitHandler } from '../src/main/graceful-shutdown'

describe('graceful before-quit', () => {
  it('首次退出等待异步 cleanup，重入不重复清理，完成后放行退出', async () => {
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const cleanup = vi.fn(() => cleanupGate)
    const requestQuit = vi.fn()
    const handler = createGracefulBeforeQuitHandler(cleanup, requestQuit)
    const first = { preventDefault: vi.fn() }
    const repeated = { preventDefault: vi.fn() }

    handler(first)
    handler(repeated)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(requestQuit).not.toHaveBeenCalled()

    releaseCleanup()
    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce())

    const final = { preventDefault: vi.fn() }
    handler(final)
    expect(final.preventDefault).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cleanup 失败时保持拦截退出，下次退出可重试', async () => {
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('offset flush failed'))
      .mockResolvedValueOnce(undefined)
    const requestQuit = vi.fn()
    const reportError = vi.fn()
    const handler = createGracefulBeforeQuitHandler(cleanup, requestQuit, reportError)
    const failed = { preventDefault: vi.fn() }

    handler(failed)
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce())
    expect(failed.preventDefault).toHaveBeenCalledOnce()
    expect(requestQuit).not.toHaveBeenCalled()

    const retry = { preventDefault: vi.fn() }
    handler(retry)
    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce())
    expect(retry.preventDefault).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})
