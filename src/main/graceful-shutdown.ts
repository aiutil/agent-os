interface BeforeQuitEvent {
  preventDefault(): void
}

/**
 * Electron before-quit 本身不会等待 Promise。首次退出先拦截并收口异步状态，
 * cleanup 结束后再请求一次退出；第二次 before-quit 直接放行。
 */
export function createGracefulBeforeQuitHandler(
  cleanup: () => Promise<void>,
  requestQuit: () => void,
  reportError: (error: unknown) => void = console.error
): (event: BeforeQuitEvent) => void {
  let state: 'idle' | 'cleaning' | 'ready' = 'idle'
  return (event) => {
    if (state === 'ready') return
    event.preventDefault()
    if (state === 'cleaning') return
    state = 'cleaning'
    void cleanup()
      .then(() => {
        state = 'ready'
        requestQuit()
      })
      .catch((error) => {
        // 清理（尤其是消息 offset flush）失败时 fail closed：保持应用存活，
        // 允许用户在磁盘/权限问题恢复后再次退出触发重试。
        state = 'idle'
        reportError(error)
      })
  }
}
