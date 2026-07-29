// xterm 终端注册表（SPEC-004/005）。
// 每个 PTY sessionId 对应一个 Terminal 实例，跨视图切换时复用（不销毁、不丢历史）。
// 重写自 v1 src/lib/terminalRegistry.ts，改用 window.agentOs 事件 + v2 暖浅终端主题。

import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { tr } from '@shared/i18n'
import { useSessionsStore } from '../stores/sessionsStore'

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

// 保留 xterm 原生感，只把浅色模式下容易糊的 ANSI 档位映射到更清晰的 token。
function buildTerminalTheme(): ITheme {
  const isDark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
  const primary = cssVar('--text-primary', isDark ? '#ececee' : '#1d1d1f')
  const secondary = cssVar('--text-secondary', isDark ? '#adadb3' : '#6b6b70')
  const muted = cssVar('--text-muted', isDark ? '#86868c' : '#7d7d84')
  const background = cssVar('--term-bg', isDark ? '#1e1d1a' : '#ffffff')

  return {
    background,
    foreground: cssVar('--term-fg', primary),
    cursor: primary,
    selectionBackground: cssVar('--term-selection', isDark ? '#3a3530' : '#e4e4e7'),
    black: isDark ? '#101012' : primary,
    red: cssVar('--status-danger', isDark ? '#e0685a' : '#c0392b'),
    green: cssVar('--status-ok', isDark ? '#6fae6f' : '#4f7a4f'),
    yellow: cssVar('--accent-gold', isDark ? '#d6a44a' : '#9a6f12'),
    blue: cssVar('--status-resumable', isDark ? '#6f9bd6' : '#3d63a8'),
    magenta: cssVar('--tool-opencode', isDark ? '#a98bc9' : '#8065a3'),
    cyan: cssVar('--tool-openclaw', isDark ? '#79b8cc' : '#307b8c'),
    white: secondary,
    brightBlack: muted,
    brightRed: cssVar('--danger', isDark ? '#e0685a' : '#b8332a'),
    brightGreen: cssVar('--status-working', isDark ? '#6fae6f' : '#3f7b3f'),
    brightYellow: cssVar('--status-waiting', isDark ? '#d6a44a' : '#9a6f12'),
    brightBlue: cssVar('--tool-codex', isDark ? '#6f9bd6' : '#315fa8'),
    brightMagenta: cssVar('--tool-opencode', isDark ? '#a98bc9' : '#744e9f'),
    brightCyan: cssVar('--tool-openclaw', isDark ? '#79b8cc' : '#247789'),
    brightWhite: primary
  }
}

interface RegistryEntry {
  terminal: Terminal
  fitAddon: FitAddon
  container?: HTMLElement
  disposers: Array<() => void>
  hydrated: boolean
  exitCode: number | null
}

const registry = new Map<string, RegistryEntry>()
let themeObserver: MutationObserver | null = null

function refreshTerminalTheme(entry: RegistryEntry): void {
  entry.terminal.options.theme = buildTerminalTheme()
}

function ensureThemeObserver(): void {
  if (themeObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
  themeObserver = new MutationObserver(() => {
    registry.forEach((entry) => refreshTerminalTheme(entry))
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style']
  })
}

function createEntry(sessionId: string): RegistryEntry {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 8000,
    theme: buildTerminalTheme()
  })
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  const entry: RegistryEntry = {
    terminal,
    fitAddon,
    disposers: [],
    hydrated: false,
    exitCode: null
  }

  // 订阅主进程数据/退出事件（按 sessionId 过滤）。
  entry.disposers.push(
    window.agentOs.events.onTerminalData((event) => {
      if (event.sessionId === sessionId) terminal.write(event.data)
    })
  )
  entry.disposers.push(
    window.agentOs.events.onTerminalExit((event) => {
      if (event.sessionId !== sessionId) return
      entry.exitCode = event.exitCode
      terminal.writeln(`\r\n${tr('system.terminal.sessionExited', { exitCode: event.exitCode })}`)
    })
  )
  const inputDispose = terminal.onData((data) => {
    const refreshAfterWrite = /[\r\n]/.test(data)
    void window.agentOs.terminal.write({ sessionId, data }).then(() => {
      if (refreshAfterWrite) void useSessionsStore.getState().refresh()
    })
  })
  entry.disposers.push(() => inputDispose.dispose())

  registry.set(sessionId, entry)
  return entry
}

export function attachTerminalSession(sessionId: string, container: HTMLElement): RegistryEntry {
  ensureThemeObserver()
  const entry = registry.get(sessionId) ?? createEntry(sessionId)
  entry.container = container
  refreshTerminalTheme(entry)

  container.textContent = ''
  if (entry.terminal.element) {
    container.appendChild(entry.terminal.element)
  } else {
    entry.terminal.open(container)
  }

  if (!entry.hydrated) {
    entry.hydrated = true
    void window.agentOs.terminal.history(sessionId).then((history) => {
      if (history) entry.terminal.write(history)
    })
  }

  window.requestAnimationFrame(() => fitTerminalSession(sessionId))
  return entry
}

export function fitTerminalSession(sessionId: string): void {
  const entry = registry.get(sessionId)
  if (!entry) return
  try {
    entry.fitAddon.fit()
    void window.agentOs.terminal.resize({
      sessionId,
      cols: entry.terminal.cols,
      rows: entry.terminal.rows
    })
  } catch {
    // container 尚未布局完成，下一帧再 fit
  }
}

export function detachTerminalSession(sessionId: string): void {
  const entry = registry.get(sessionId)
  if (!entry?.container) return
  entry.container.textContent = ''
  entry.container = undefined
}

export function disposeTerminalSession(sessionId: string): void {
  const entry = registry.get(sessionId)
  if (!entry) return
  entry.disposers.forEach((dispose) => dispose())
  entry.terminal.dispose()
  registry.delete(sessionId)
}
