import { randomUUID } from 'node:crypto'
import WebSocket, { type ClientOptions } from 'ws'
import type {
  CreateSessionInput,
  CreateTaskInput,
  AgentTask,
  ChatTurnState,
  ManagedChatMessage,
  ManagedQueuedTurn,
  ManagedChatTimelineItem,
  ListRuntimeDirectoriesInput,
  HostEvent,
  RuntimeHello,
  RuntimeDirectoryListing,
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
import type { RuntimeEventListener, RuntimeHost } from './protocol'
import type {
  DaemonEnvelope,
  DaemonRpcMethod,
  DaemonRpcParams,
  DaemonRpcResponse,
  DaemonTerminalProbe
} from './daemon-protocol'
import { parseDaemonEnvelope } from './daemon-protocol'
import { assertLoopbackAddress } from './daemon-server'

interface ConnectOptions {
  url: string
  token: string
  expectedProtocolVersion: number
  expectedHostVersion?: string
  expectedRuntimeBuildId?: string
  timeoutMs?: number
  onDisconnect?: (error?: Error) => void
  /** 远程节点（LAN）连接：放开 loopback 限制。本地 daemon 不传，行为不变。 */
  allowRemote?: boolean
  /** 传给底层 ws 的连接选项（远程用于 WSS + 自签证书指纹 pin）。 */
  wsOptions?: ClientOptions
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

export { assertLoopbackAddress }

export class DaemonRuntimeHost implements RuntimeHost {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<RuntimeEventListener>()
  private manuallyClosed = false
  private lastHeartbeatAt = Date.now()
  private readonly heartbeatTimer: NodeJS.Timeout

  private constructor(
    private readonly socket: WebSocket,
    private readonly options: ConnectOptions
  ) {
    socket.on('message', (data) => this.onMessage(data.toString()))
    socket.on('close', () => this.onClose())
    socket.on('error', () => undefined)
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeatAt > 3_500) {
        socket.terminate()
      }
    }, 1_000)
    this.heartbeatTimer.unref()
  }

  /**
   * 接管一条「已经打开」的 socket 当 RPC 驱动端（SPEC-032：节点反向拨回主控后，
   * 主控用此驱动节点）。与 connect 不同：不拨号、不做 loopback 限制、由调用方在 attach 后自行 hello 校验。
   */
  static adopt(
    socket: WebSocket,
    options: { onDisconnect?: (error?: Error) => void } = {}
  ): DaemonRuntimeHost {
    return new DaemonRuntimeHost(socket, {
      url: '',
      token: '',
      expectedProtocolVersion: 0,
      allowRemote: true,
      onDisconnect: options.onDisconnect
    })
  }

  static async connect(options: ConnectOptions): Promise<DaemonRuntimeHost> {
    const parsed = new URL(options.url)
    if (!options.allowRemote) assertLoopbackAddress(parsed.hostname)
    parsed.searchParams.set('token', options.token)
    const socket = options.wsOptions
      ? new WebSocket(parsed, options.wsOptions)
      : new WebSocket(parsed)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('daemon 连接超时')),
        options.timeoutMs ?? 2_000
      )
      socket.once('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timeout)
        reject(
          new Error(response.statusCode === 401 ? 'daemon token 鉴权失败' : 'daemon 连接被拒绝')
        )
      })
      socket.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
    const client = new DaemonRuntimeHost(socket, options)
    const hello = await client.hello()
    if (hello.protocolVersion !== options.expectedProtocolVersion) {
      await client.close()
      throw new Error(
        `daemon 协议版本不匹配：期望 ${options.expectedProtocolVersion}，实际 ${hello.protocolVersion}`
      )
    }
    if (options.expectedHostVersion && hello.hostVersion !== options.expectedHostVersion) {
      await client.close()
      throw new Error(
        `daemon 主程序版本不匹配：期望 ${options.expectedHostVersion}，实际 ${hello.hostVersion}`
      )
    }
    if (options.expectedRuntimeBuildId && hello.runtimeBuildId !== options.expectedRuntimeBuildId) {
      await client.close()
      throw new Error(
        `daemon 构建不匹配：期望 ${options.expectedRuntimeBuildId}，实际 ${hello.runtimeBuildId}`
      )
    }
    return client
  }

  hello(): Promise<RuntimeHello> {
    return this.call('hello', [])
  }
  hostStatus(): Promise<RuntimeHostStatus> {
    return this.call('hostStatus', [])
  }
  probeTerminal(): Promise<DaemonTerminalProbe> {
    return this.call('probeTerminal', [])
  }
  listRuntimes(): Promise<RuntimeInfo[]> {
    return this.call('listRuntimes', [])
  }
  listModels(toolId: string): Promise<ToolModelCatalog> {
    return this.call('listModels', [toolId])
  }
  listDirectories(input?: ListRuntimeDirectoriesInput): Promise<RuntimeDirectoryListing> {
    return this.call('listDirectories', [input ?? {}])
  }
  listSessions(): Promise<WorkbenchSession[]> {
    return this.call('listSessions', [])
  }
  listSessionViews(): Promise<WorkbenchSessionView[]> {
    return this.call('listSessionViews', [])
  }
  createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    return this.call('createSession', [input])
  }
  resumeSession(id: string): Promise<RuntimeSessionHandle> {
    return this.call('resumeSession', [id])
  }
  openLinkedTerminal(id: string): Promise<RuntimeSessionHandle> {
    return this.call('openLinkedTerminal', [id])
  }
  updateSession(id: string, patch: UpdateSessionPatch): Promise<WorkbenchSession | null> {
    return this.call('updateSession', [id, patch])
  }
  async removeSession(id: string): Promise<void> {
    await this.call('removeSession', [id])
  }
  write(sessionId: string, data: string): Promise<boolean> {
    return this.call('write', [sessionId, data])
  }
  resize(sessionId: string, cols: number, rows: number): Promise<boolean> {
    return this.call('resize', [sessionId, cols, rows])
  }
  history(sessionId: string): Promise<string> {
    return this.call('history', [sessionId])
  }
  state(sessionId: string): Promise<TerminalRunState | null> {
    return this.call('state', [sessionId])
  }
  states(): Promise<TerminalRunState[]> {
    return this.call('states', [])
  }
  kill(sessionId: string): Promise<boolean> {
    return this.call('kill', [sessionId])
  }
  sendTurn(sessionId: string, text: string, files?: string[], contextPack?: import('@shared/types').TurnContextPack): Promise<ChatTurnState> {
    return this.call('sendTurn', contextPack ? [sessionId, text, files ?? [], contextPack] : files?.length ? [sessionId, text, files] : [sessionId, text])
  }
  steerTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState> {
    return this.call('steerTurn', files?.length ? [sessionId, text, files] : [sessionId, text])
  }
  queueTurn(sessionId: string, text: string, files?: string[], contextPack?: import('@shared/types').TurnContextPack): Promise<ManagedQueuedTurn> {
    return this.call('queueTurn', contextPack ? [sessionId, text, files ?? [], contextPack] : files?.length ? [sessionId, text, files] : [sessionId, text])
  }
  listQueuedTurns(sessionId: string): Promise<ManagedQueuedTurn[]> {
    return this.call('listQueuedTurns', [sessionId])
  }
  cancelQueuedTurn(sessionId: string, queuedTurnId: string): Promise<boolean> {
    return this.call('cancelQueuedTurn', [sessionId, queuedTurnId])
  }
  interruptTurn(sessionId: string): Promise<boolean> {
    return this.call('interruptTurn', [sessionId])
  }
  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<ChatTurnState> {
    return this.call('respondPermission', [sessionId, requestId, decision])
  }
  chatState(sessionId: string): Promise<ChatTurnState> {
    return this.call('chatState', [sessionId])
  }
  chatHistory(sessionId: string): Promise<ManagedChatMessage[]> {
    return this.call('chatHistory', [sessionId])
  }
  chatTimeline(sessionId: string): Promise<ManagedChatTimelineItem[]> {
    return this.call('chatTimeline', [sessionId])
  }
  listTasks(): Promise<AgentTask[]> {
    return this.call('listTasks', [])
  }
  listTaskRuns(taskId: string): Promise<TaskRun[]> {
    return this.call('listTaskRuns', [taskId])
  }
  createTask(input: CreateTaskInput): Promise<AgentTask> {
    return this.call('createTask', [input])
  }
  updateTask(id: string, patch: UpdateTaskPatch): Promise<AgentTask | null> {
    return this.call('updateTask', [id, patch])
  }
  async removeTask(id: string): Promise<void> {
    await this.call('removeTask', [id])
  }
  runTaskNow(id: string): Promise<TaskRun> {
    return this.call('runTaskNow', [id])
  }

  attach(sessionId: string): AsyncIterable<HostEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const queue: HostEvent[] = []
        const waiters: Array<(result: IteratorResult<HostEvent>) => void> = []
        let closed = false
        const unsubscribe = this.subscribe((event) => {
          if (!('sessionId' in event) || event.sessionId !== sessionId || closed) return
          const waiter = waiters.shift()
          if (waiter) waiter({ value: event, done: false })
          else queue.push(event)
        })
        return {
          next: async () => {
            const event = queue.shift()
            if (event) return { value: event, done: false }
            if (closed) return { value: undefined, done: true }
            return new Promise((resolve) => waiters.push(resolve))
          },
          return: async () => {
            closed = true
            unsubscribe()
            for (const waiter of waiters.splice(0)) {
              waiter({ value: undefined, done: true })
            }
            return { value: undefined, done: true }
          }
        }
      }
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.manuallyClosed = true
    clearInterval(this.heartbeatTimer)
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve())
      this.socket.close()
    })
  }

  private call<T>(method: DaemonRpcMethod, params: DaemonRpcParams): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('daemon 未连接'))
    }
    const id = randomUUID()
    const envelope: DaemonEnvelope = { type: 'request', id, method, params }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      })
      this.socket.send(JSON.stringify(envelope))
    })
  }

  private onMessage(raw: string): void {
    let envelope: DaemonEnvelope
    try {
      envelope = parseDaemonEnvelope(raw)
    } catch {
      return
    }
    if (envelope.type === 'event') {
      for (const listener of this.listeners) listener(envelope.event)
      return
    }
    if (envelope.type === 'heartbeat') {
      this.lastHeartbeatAt = envelope.at
      return
    }
    if (envelope.type !== 'response') return
    const pending = this.pending.get(envelope.id)
    if (!pending) return
    this.pending.delete(envelope.id)
    if (envelope.error) pending.reject(new Error(envelope.error))
    else pending.resolve((envelope as DaemonRpcResponse).result)
  }

  private onClose(): void {
    clearInterval(this.heartbeatTimer)
    const error = new Error('daemon 连接已断开')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!this.manuallyClosed) this.options.onDisconnect?.(error)
  }
}
