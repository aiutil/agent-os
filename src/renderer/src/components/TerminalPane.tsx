// 终端镜头（SPEC-004/005）。把指定 PTY sessionId 的 xterm 实例挂到 DOM。
// 视图切换时只 detach/attach，不销毁实例，保留滚动与历史。

import { useEffect, useRef } from 'react'
import {
  attachTerminalSession,
  detachTerminalSession,
  fitTerminalSession
} from '../lib/terminalRegistry'
import './TerminalPane.css'

interface TerminalPaneProps {
  sessionId: string
}

export function TerminalPane({ sessionId }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    attachTerminalSession(sessionId, container)

    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => fitTerminalSession(sessionId))
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      detachTerminalSession(sessionId)
    }
  }, [sessionId])

  return <div className="terminal-pane" ref={containerRef} />
}
