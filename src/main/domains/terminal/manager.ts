// PTY 终端会话管理（SPEC-004）。
// 重写自 v1 electron/terminal-manager.cjs：node-pty 主路径 + child_process 兜底，
// 256KB 会话缓冲、idle 检测、断开延迟清理；状态推进委托给 TerminalRunStateMachine。

import os from 'node:os'
import fs from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execSync, spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import nodePty, { type IPty } from 'node-pty'
import { TerminalRunStateMachine, sanitizeTail } from './run-state'
import type {
  LaunchTerminalInput,
  TerminalBackend,
  TerminalRunState,
  TerminalSessionInfo
} from '@shared/types'

const MAX_SESSION_BUFFER = 256_000
const DISCONNECT_GRACE_MS = 30_000
const BOOTSTRAP_DELAY_MS = 280

/** 主进程 → 渲染端事件发射器。 */
export type EmitFn = (channel: string, payload: unknown) => void

interface TerminalIO {
  onData(handler: (data: string) => void): void
  onExit(handler: (event: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface InternalSession {
  id: string
  toolId: string
  cwd: string
  command: string
  shell: string
  backend: TerminalBackend
  createdAt: string
  io: TerminalIO
  buffer: string
}

let cachedShellPath: string | null = null

function buildTerminalEnv(): NodeJS.ProcessEnv {
  if (cachedShellPath === null && process.platform !== 'win32') {
    try {
      cachedShellPath = execSync(
        `${JSON.stringify(process.env.SHELL || '/bin/zsh')} -lc 'printf %s "$PATH"'`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: process.env }
      ).trim()
    } catch {
      cachedShellPath = ''
    }
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: cachedShellPath || process.env.PATH,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }
  delete env.npm_config_prefix
  delete env.NPM_CONFIG_PREFIX
  delete env.npm_config_userconfig
  return env
}

function resolveShellCandidates(): string[] {
  if (process.platform === 'win32') {
    // Windows PowerShell 5.x (powershell.exe) 随系统自带、恒在 PATH；pwsh.exe(PS7) 与 cmd 兜底。
    return ['powershell.exe', 'pwsh.exe', process.env.COMSPEC || 'cmd.exe']
  }
  const raw = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean) as string[]
  return Array.from(new Set(raw))
}

/** Windows 下沿 PATH 查找可执行文件（补 PATHEXT）；非 Windows 返回 null。 */
function findOnWindowsPath(exe: string): string | null {
  if (process.platform !== 'win32') return null
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue
    for (const ext of exts) {
      const name = exe.toLowerCase().endsWith(ext.toLowerCase()) ? exe : exe + ext
      const full = join(dir, name)
      if (fs.existsSync(full)) return full
    }
  }
  return null
}

function pickExistingShell(candidates: string[]): string {
  if (process.platform === 'win32') {
    for (const candidate of candidates) {
      if (findOnWindowsPath(candidate)) return candidate
    }
    return 'powershell.exe' // System32 恒在
  }
  for (const candidate of candidates) {
    if (!candidate.includes('/')) return candidate
    if (fs.existsSync(candidate)) return candidate
  }
  return '/bin/zsh'
}

/** 按平台/外壳构造参数；mac/linux 分支与原实现语义一致。 */
function buildShellArgs(shell: string, launchCommand: string | null): string[] {
  if (process.platform === 'win32') {
    const base = (shell.split(/[\\/]/).pop() || shell).toLowerCase()
    if (base === 'powershell.exe' || base === 'pwsh.exe') {
      // -NoLogo -NoProfile：快且确定；-Command 跑目标 CLI，CLI 退出即 PS 退出（等同 exec）。
      return launchCommand ? ['-NoLogo', '-NoProfile', '-Command', launchCommand] : ['-NoLogo', '-NoProfile']
    }
    if (base === 'cmd.exe' || base === 'cmd') {
      return launchCommand ? ['/K', launchCommand] : []
    }
    return launchCommand ? ['/C', launchCommand] : []
  }
  return launchCommand ? ['-lc', launchCommand] : ['-l']
}

/** node-pty 依次尝试的参数组合：Windows 单组；mac/linux 保持原双组（带 command 仅 -lc）。 */
function argsCandidatesFor(shell: string, launchCommand: string | null): string[][] {
  if (process.platform === 'win32') return [buildShellArgs(shell, launchCommand)]
  return launchCommand ? [['-lc', launchCommand]] : [['-l'], []]
}

function buildLaunchCommand(command: string): string | null {
  if (!command || !command.trim()) return null
  const trimmed = command.trim()
  // Windows 无需 bash 包装：npm_config_* 已在 buildTerminalEnv 的 env 里删除，直接跑命令。
  if (process.platform === 'win32') return trimmed
  return `unset npm_config_prefix NPM_CONFIG_PREFIX npm_config_userconfig >/dev/null 2>&1; exec ${trimmed}`
}

interface SpawnSelection {
  io?: TerminalIO
  shell: string
  backend: TerminalBackend
  bootstrapMode: 'already-launched' | 'inject-command'
  error?: string
}

function tryNodePtySpawn(
  cwd: string,
  env: NodeJS.ProcessEnv,
  shellCandidates: string[],
  command: string
): SpawnSelection {
  const errors: string[] = []
  const launchCommand = buildLaunchCommand(command)
  for (const shell of shellCandidates) {
    const argsCandidates = argsCandidatesFor(shell, launchCommand)
    for (const args of argsCandidates) {
      try {
        const pty = nodePty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd,
          env: env as { [key: string]: string }
        })
        return { io: wrapPty(pty), shell, backend: 'pty', bootstrapMode: launchCommand ? 'already-launched' : 'inject-command' }
      } catch (error) {
        errors.push(`${shell} ${args.join(' ')} => ${(error as Error).message}`)
      }
    }
  }
  return { shell: '', backend: 'pty', bootstrapMode: 'inject-command', error: `node-pty unavailable; ${errors.join(' | ')}` }
}

function wrapPty(pty: IPty): TerminalIO {
  return {
    onData: (handler) => {
      pty.onData(handler)
    },
    onExit: (handler) => {
      pty.onExit(({ exitCode }) => handler({ exitCode }))
    },
    write: (data) => pty.write(data),
    resize: (cols, rows) => {
      try {
        pty.resize(cols, rows)
      } catch {
        // ignore resize on dead pty
      }
    },
    kill: () => {
      try {
        pty.kill()
      } catch {
        // ignore
      }
    }
  }
}

function wrapChild(child: ChildProcess): TerminalIO {
  const emitter = new EventEmitter()
  child.stdout?.on('data', (chunk: Buffer) => emitter.emit('data', chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => emitter.emit('data', chunk.toString()))
  child.on('exit', (code) => emitter.emit('exit', { exitCode: code ?? 0 }))
  return {
    onData: (handler) => emitter.on('data', handler),
    onExit: (handler) => emitter.on('exit', handler),
    write: (data) => child.stdin?.write(data),
    resize: () => undefined,
    kill: () => child.kill('SIGTERM')
  }
}

function tryChildFallback(
  cwd: string,
  env: NodeJS.ProcessEnv,
  shell: string,
  command: string
): SpawnSelection {
  const launchCommand = buildLaunchCommand(command)
  const args =
    process.platform === 'win32'
      ? buildShellArgs(shell, launchCommand)
      : launchCommand
        ? ['-lc', launchCommand]
        : ['-il']
  try {
    const child = spawnProcess(shell, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    return { io: wrapChild(child), shell, backend: 'shell-pty', bootstrapMode: launchCommand ? 'already-launched' : 'inject-command' }
  } catch (error) {
    return { shell, backend: 'shell-pty', bootstrapMode: 'inject-command', error: (error as Error).message }
  }
}

export class TerminalManager {
  private readonly sessions = new Map<string, InternalSession>()
  private readonly runState = new TerminalRunStateMachine()
  private readonly idleTimers = new Map<string, NodeJS.Timeout>()
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>()
  private readonly exitListeners = new Map<
    string,
    Array<(exitCode: number, intentionallyClosed: boolean) => void>
  >()
  private readonly intentionalCloses = new Set<string>()
  private emit: EmitFn

  constructor(emit: EmitFn) {
    this.emit = emit
  }

  setEmit(emit: EmitFn): void {
    this.emit = emit
  }

  private emitStateChange(sessionId: string, prevStatus: TerminalRunState['status']): void {
    const state = this.runState.getState(sessionId)
    if (!state) return
    this.emit('terminal:stateChanged', { sessionId, state: { ...state }, prevStatus })
  }

  private scheduleIdleCheck(sessionId: string): void {
    this.cancelIdleCheck(sessionId)
    const handle = setTimeout(() => {
      const prev = this.runState.getState(sessionId)?.status
      const next = this.runState.feedIdle(sessionId)
      if (next && prev && prev !== next.status) this.emitStateChange(sessionId, prev)
    }, this.runState.idleThresholdMs)
    this.idleTimers.set(sessionId, handle)
  }

  private cancelIdleCheck(sessionId: string): void {
    const handle = this.idleTimers.get(sessionId)
    if (handle) {
      clearTimeout(handle)
      this.idleTimers.delete(sessionId)
    }
  }

  private scheduleDisconnectRemoval(sessionId: string): void {
    this.cancelDisconnectRemoval(sessionId)
    const handle = setTimeout(() => {
      this.runState.removeState(sessionId)
      this.disconnectTimers.delete(sessionId)
    }, DISCONNECT_GRACE_MS)
    this.disconnectTimers.set(sessionId, handle)
  }

  private cancelDisconnectRemoval(sessionId: string): void {
    const handle = this.disconnectTimers.get(sessionId)
    if (handle) {
      clearTimeout(handle)
      this.disconnectTimers.delete(sessionId)
    }
  }

  openSession(input: LaunchTerminalInput): TerminalSessionInfo {
    const { toolId, command } = input
    // cwd 兜底：空或不存在时回退到用户主目录，避免 PTY 启动失败。
    const cwd = input.cwd && fs.existsSync(input.cwd) ? input.cwd : os.homedir()
    const sessionId = randomUUID()
    const env = { ...buildTerminalEnv(), ...(input.env ?? {}) }
    const shellCandidates = resolveShellCandidates()
    const selectedShell = pickExistingShell(shellCandidates)

    const ptyResult = tryNodePtySpawn(cwd, env, shellCandidates, command)
    const selected = ptyResult.error
      ? tryChildFallback(cwd, env, selectedShell, command)
      : ptyResult

    if (!selected.io) {
      const errors = [ptyResult.error, selected.error].filter(Boolean).join('; ')
      throw new Error(errors || 'terminal backend initialization failed')
    }

    const { io, shell, backend, bootstrapMode } = selected
    let bootstrapped = bootstrapMode === 'already-launched'
    const runBootstrapCommand = (): void => {
      if (bootstrapped || !command || !command.trim()) return
      bootstrapped = true
      io.write(
        process.platform === 'win32'
          ? `${command.trim()}\r`
          : `unset npm_config_prefix NPM_CONFIG_PREFIX npm_config_userconfig >/dev/null 2>&1; ${command.trim()}\r`
      )
    }

    io.onData((data) => {
      if (!bootstrapped) runBootstrapCommand()
      const session = this.sessions.get(sessionId)
      if (session) session.buffer = `${session.buffer}${data}`.slice(-MAX_SESSION_BUFFER)
      const prevStatus = this.runState.getState(sessionId)?.status
      this.runState.feedData(sessionId, data)
      this.scheduleIdleCheck(sessionId)
      const nextStatus = this.runState.getState(sessionId)?.status
      if (prevStatus && nextStatus && prevStatus !== nextStatus) this.emitStateChange(sessionId, prevStatus)
      this.emit('terminal:data', { sessionId, data })
    })

    io.onExit(({ exitCode }) => {
      this.cancelIdleCheck(sessionId)
      const prevStatus = this.runState.getState(sessionId)?.status
      this.runState.feedExit(sessionId, exitCode)
      const nextStatus = this.runState.getState(sessionId)?.status
      if (prevStatus && nextStatus && prevStatus !== nextStatus) this.emitStateChange(sessionId, prevStatus)
      this.emit('terminal:exit', { sessionId, exitCode })
      const intentionallyClosed = this.intentionalCloses.delete(sessionId)
      for (const listener of this.exitListeners.get(sessionId) ?? []) {
        listener(exitCode, intentionallyClosed)
      }
      this.exitListeners.delete(sessionId)
      this.sessions.delete(sessionId)
    })

    if (!bootstrapped) setTimeout(runBootstrapCommand, BOOTSTRAP_DELAY_MS)

    const createdAt = new Date().toISOString()
    this.sessions.set(sessionId, {
      id: sessionId,
      toolId,
      cwd,
      command,
      shell,
      backend,
      createdAt,
      io,
      buffer: ''
    })
    this.runState.createState({ sessionId, toolId, workspacePath: cwd, command, backend })

    return { sessionId, toolId, cwd, command, backend, createdAt }
  }

  write(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.io.write(data)
    return true
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.io.resize(cols, rows)
    return true
  }

  getHistory(sessionId: string): string {
    return this.sessions.get(sessionId)?.buffer ?? ''
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.intentionalCloses.add(sessionId)
    session.io.kill()
    this.sessions.delete(sessionId)
    this.cancelIdleCheck(sessionId)
    const prevStatus = this.runState.getState(sessionId)?.status
    this.runState.feedDisconnected(sessionId)
    if (prevStatus && prevStatus !== 'disconnected') this.emitStateChange(sessionId, prevStatus)
    this.scheduleDisconnectRemoval(sessionId)
    return true
  }

  getState(sessionId: string): TerminalRunState | null {
    const state = this.runState.getState(sessionId)
    return state ? { ...state } : null
  }

  listStates(): TerminalRunState[] {
    return this.runState.listStates().map((state) => ({ ...state }))
  }

  onExit(
    sessionId: string,
    listener: (exitCode: number, intentionallyClosed: boolean) => void
  ): void {
    const listeners = this.exitListeners.get(sessionId) ?? []
    listeners.push(listener)
    this.exitListeners.set(sessionId, listeners)
  }

  /** 调试用：会话尾巴。 */
  tail(sessionId: string): string {
    return sanitizeTail(this.getHistory(sessionId))
  }
}
