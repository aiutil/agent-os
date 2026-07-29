import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type {
  CreateSessionInput,
  CreateTaskInput,
  AgentTask,
  ChatTurnState,
  ManagedChatMessage,
  ManagedQueuedTurn,
  ManagedChatTimelineItem,
  HostEvent,
  ListRuntimeDirectoriesInput,
  RuntimeDirectoryListing,
  RuntimeHello,
  RuntimeHostStatus,
  RuntimeInfo,
  RuntimeSessionHandle,
  TerminalRunState,
  TaskRun,
  ToolModelCatalog,
  UpdateSessionPatch,
  UpdateTaskPatch,
  WorkbenchSession,
  WorkbenchSessionView
} from '@shared/types'
import type { PermissionDecision } from '@shared/types'
import { RUNTIME_PROTOCOL_VERSION } from '@shared/types'
import type { RuntimeEventListener, RuntimeHost } from './protocol'
import { DaemonRuntimeHost } from './daemon-runtime-host'
import {
  degradedStatus,
  readDaemonConfig,
  writeDaemonConfig,
  type DaemonConfig
} from './daemon-config'
import { acquireDaemonSpawnLock } from './daemon-spawn-lock'

interface SupervisedRuntimeHostOptions {
  daemonEntry: string
  daemonConfigFile: string
  sessionsFile: string
  tasksFile: string
  chatStoreFile: string
  providerStoreFile: string
  hostVersion: string
  runtimeBuildId: string
  fallback: RuntimeHost
  fallbackTasks?: {
    start(): void
    close(): void
  }
  reconnectDelayMs?: number
  spawnTimeoutMs?: number
}

function processIsAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function terminate(pid: number | undefined): void {
  if (!processIsAlive(pid)) return
  try {
    process.kill(pid!, 'SIGTERM')
  } catch {
    // stale PID or process already exited
  }
}

export class SupervisedRuntimeHost implements RuntimeHost {
  private delegate: RuntimeHost
  private daemon: DaemonRuntimeHost | null = null
  private fallbackReason = 'daemon 尚未连接'
  private reconnecting: Promise<void> | null = null
  private readonly listeners = new Set<RuntimeEventListener>()
  private unsubscribeDelegate: (() => void) | null = null
  private fallbackTasksActive = false

  private constructor(private readonly options: SupervisedRuntimeHostOptions) {
    this.delegate = options.fallback
    this.bindDelegate(options.fallback)
  }

  static async create(options: SupervisedRuntimeHostOptions): Promise<SupervisedRuntimeHost> {
    const host = new SupervisedRuntimeHost(options)
    await host.connectOrFallback()
    return host
  }

  async restartDaemon(): Promise<RuntimeHostStatus> {
    const config = readDaemonConfig(this.options.daemonConfigFile)
    const connectedStatus = await this.daemon?.hostStatus().catch(() => null)
    await this.daemon?.close().catch(() => undefined)
    terminate(connectedStatus?.pid ?? config?.pid)
    this.daemon = null
    this.fallbackReason = '正在重启 daemon'
    this.setDelegate(this.options.fallback)
    await this.spawnAndConnect(true)
    return this.hostStatus()
  }

  hello(): Promise<RuntimeHello> {
    return this.delegate.hello()
  }
  async hostStatus(): Promise<RuntimeHostStatus> {
    if (this.daemon) return this.daemon.hostStatus()
    const sessions = await this.options.fallback.listSessions()
    return degradedStatus(
      this.options.hostVersion,
      this.options.runtimeBuildId,
      RUNTIME_PROTOCOL_VERSION,
      sessions.length,
      this.fallbackReason
    )
  }
  listRuntimes(): Promise<RuntimeInfo[]> {
    return this.delegate.listRuntimes()
  }
  listModels(toolId: string): Promise<ToolModelCatalog> {
    return this.delegate.listModels(toolId)
  }
  listDirectories(input?: ListRuntimeDirectoriesInput): Promise<RuntimeDirectoryListing> {
    return this.delegate.listDirectories(input)
  }
  listSessions(): Promise<WorkbenchSession[]> {
    return this.delegate.listSessions()
  }
  listSessionViews(): Promise<WorkbenchSessionView[]> {
    return this.delegate.listSessionViews()
  }
  createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    return this.delegate.createSession(input)
  }
  resumeSession(id: string): Promise<RuntimeSessionHandle> {
    return this.delegate.resumeSession(id)
  }
  openLinkedTerminal(id: string): Promise<RuntimeSessionHandle> {
    return this.delegate.openLinkedTerminal(id)
  }
  updateSession(id: string, patch: UpdateSessionPatch): Promise<WorkbenchSession | null> {
    return this.delegate.updateSession(id, patch)
  }
  removeSession(id: string): Promise<void> {
    return this.delegate.removeSession(id)
  }
  write(sessionId: string, data: string): Promise<boolean> {
    return this.delegate.write(sessionId, data)
  }
  resize(sessionId: string, cols: number, rows: number): Promise<boolean> {
    return this.delegate.resize(sessionId, cols, rows)
  }
  history(sessionId: string): Promise<string> {
    return this.delegate.history(sessionId)
  }
  state(sessionId: string): Promise<TerminalRunState | null> {
    return this.delegate.state(sessionId)
  }
  states(): Promise<TerminalRunState[]> {
    return this.delegate.states()
  }
  kill(sessionId: string): Promise<boolean> {
    return this.delegate.kill(sessionId)
  }
  sendTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    return this.delegate.sendTurn(sessionId, text, files)
  }
  steerTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    return this.delegate.steerTurn(sessionId, text, files)
  }
  queueTurn(sessionId: string, text: string, files?: string[]): Promise<ManagedQueuedTurn> {
    return this.delegate.queueTurn(sessionId, text, files)
  }
  listQueuedTurns(sessionId: string): Promise<ManagedQueuedTurn[]> {
    return this.delegate.listQueuedTurns(sessionId)
  }
  cancelQueuedTurn(sessionId: string, queuedTurnId: string): Promise<boolean> {
    return this.delegate.cancelQueuedTurn(sessionId, queuedTurnId)
  }
  interruptTurn(sessionId: string): Promise<boolean> {
    return this.delegate.interruptTurn(sessionId)
  }
  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<ChatTurnState> {
    return this.delegate.respondPermission(sessionId, requestId, decision)
  }
  chatState(sessionId: string): Promise<ChatTurnState> {
    return this.delegate.chatState(sessionId)
  }
  chatHistory(sessionId: string): Promise<ManagedChatMessage[]> {
    return this.delegate.chatHistory(sessionId)
  }
  chatTimeline(sessionId: string): Promise<ManagedChatTimelineItem[]> {
    return this.delegate.chatTimeline(sessionId)
  }
  listTasks(): Promise<AgentTask[]> {
    return this.delegate.listTasks()
  }
  listTaskRuns(taskId: string): Promise<TaskRun[]> {
    return this.delegate.listTaskRuns(taskId)
  }
  createTask(input: CreateTaskInput): Promise<AgentTask> {
    return this.delegate.createTask(input)
  }
  updateTask(id: string, patch: UpdateTaskPatch): Promise<AgentTask | null> {
    return this.delegate.updateTask(id, patch)
  }
  removeTask(id: string): Promise<void> {
    return this.delegate.removeTask(id)
  }
  runTaskNow(id: string): Promise<TaskRun> {
    return this.delegate.runTaskNow(id)
  }
  attach(sessionId: string): AsyncIterable<HostEvent> {
    return this.delegate.attach(sessionId)
  }
  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async connectOrFallback(): Promise<void> {
    const config = readDaemonConfig(this.options.daemonConfigFile)
    if (config?.port && processIsAlive(config.pid)) {
      try {
        await this.connect(config)
        return
      } catch (error) {
        this.fallbackReason = error instanceof Error ? error.message : String(error)
        terminate(config.pid)
      }
    }
    await this.spawnAndConnect(false)
  }

  private async spawnAndConnect(forceNewToken: boolean): Promise<void> {
    const timeoutMs = this.options.spawnTimeoutMs ?? 15_000
    let lock: { release(): void } | null = null
    this.deactivateFallbackTasks()
    try {
      if (!existsSync(this.options.daemonEntry)) {
        throw new Error(`daemon 入口不存在：${this.options.daemonEntry}`)
      }
      lock = await acquireDaemonSpawnLock(
        `${this.options.daemonConfigFile}.spawn.lock`,
        timeoutMs + 1_000
      )
      const running = readDaemonConfig(this.options.daemonConfigFile)
      if (running?.port && processIsAlive(running.pid)) {
        try {
          await this.connect(running)
          return
        } catch {
          terminate(running.pid)
        }
      }
      const previous = readDaemonConfig(this.options.daemonConfigFile)
      const config: DaemonConfig = {
        token: forceNewToken || !previous?.token ? randomBytes(32).toString('hex') : previous.token,
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        hostVersion: this.options.hostVersion,
        runtimeBuildId: this.options.runtimeBuildId,
        sessionsFile: this.options.sessionsFile,
        tasksFile: this.options.tasksFile,
        chatStoreFile: this.options.chatStoreFile,
        providerStoreFile: this.options.providerStoreFile
      }
      writeDaemonConfig(this.options.daemonConfigFile, config)
      const child = spawn(process.execPath, [this.options.daemonEntry], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          AGENT_OS_DAEMON_CONFIG: this.options.daemonConfigFile
        }
      })
      child.unref()
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const ready = readDaemonConfig(this.options.daemonConfigFile)
        if (ready?.port && processIsAlive(ready.pid)) {
          await this.connect(ready)
          return
        }
      }
      throw new Error('daemon 启动超时')
    } catch (error) {
      this.fallbackReason = error instanceof Error ? error.message : String(error)
      this.daemon = null
      this.setDelegate(this.options.fallback)
      this.activateFallbackTasks()
    } finally {
      lock?.release()
    }
  }

  private async connect(config: DaemonConfig): Promise<void> {
    if (!config.port) throw new Error('daemon 端口缺失')
    const daemon = await DaemonRuntimeHost.connect({
      url: `ws://127.0.0.1:${config.port}`,
      token: config.token,
      expectedProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      expectedHostVersion: this.options.hostVersion,
      expectedRuntimeBuildId: this.options.runtimeBuildId,
      onDisconnect: () => this.scheduleReconnect()
    })
    this.daemon = daemon
    this.fallbackReason = ''
    this.deactivateFallbackTasks()
    this.setDelegate(daemon)
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return
    this.daemon = null
    this.fallbackReason = 'daemon 连接中断，正在恢复'
    this.setDelegate(this.options.fallback)
    this.activateFallbackTasks()
    this.reconnecting = new Promise((resolve) =>
      setTimeout(resolve, this.options.reconnectDelayMs ?? 300)
    )
      .then(() => this.spawnAndConnect(true))
      .finally(() => {
        this.reconnecting = null
      })
  }

  private setDelegate(delegate: RuntimeHost): void {
    this.delegate = delegate
    this.bindDelegate(delegate)
  }

  private bindDelegate(delegate: RuntimeHost): void {
    this.unsubscribeDelegate?.()
    this.unsubscribeDelegate = delegate.subscribe((event) => {
      for (const listener of this.listeners) listener(event)
    })
  }

  private activateFallbackTasks(): void {
    if (!this.options.fallbackTasks || this.fallbackTasksActive) return
    this.options.fallbackTasks.start()
    this.fallbackTasksActive = true
  }

  private deactivateFallbackTasks(): void {
    if (!this.options.fallbackTasks || !this.fallbackTasksActive) return
    this.options.fallbackTasks.close()
    this.fallbackTasksActive = false
  }
}
