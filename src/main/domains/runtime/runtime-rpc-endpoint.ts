// 传输无关的 RuntimeHost RPC「服务端点」（SPEC-032）。
// 给定一条已打开的 WebSocket（无论它是 server 接受进来的，还是 client 主动拨出去的），
// 把本地 RuntimeHost 暴露成 RPC：收 request→dispatch→回 response；订阅事件→推 event；定时 heartbeat。
//
// 这样「谁监听、谁拨号」与「谁提供 runtime」解耦：
// - 本地 daemon / 旧远程节点：server 接受 socket 后 attach（见 daemon-server.ts）。
// - SPEC-032 节点反向拨回主控：节点作为 client 拨出后 attach（节点仍是 runtime 提供方）。

import { randomBytes } from 'node:crypto'
import nodePty from 'node-pty'
import { WebSocket } from 'ws'
import type { RuntimeHost } from './protocol'
import type {
  DaemonEnvelope,
  DaemonRpcRequest,
  DaemonRpcResponse,
  DaemonTerminalProbe
} from './daemon-protocol'
import { isDaemonRpcMethod, parseDaemonEnvelope } from './daemon-protocol'

export interface RuntimeRpcServerOptions {
  runtime: RuntimeHost
  hostVersion: string
  runtimeBuildId: string
  protocolVersion: number
  pid?: number
  startedAt?: string
  /** 测试可注入失败；生产默认执行真实 node-pty 子进程回显。 */
  terminalProbe?: () => Promise<DaemonTerminalProbe>
  /** GUI 受托管连接用来在每个 RPC（含 hello/probe）前重验授权状态。 */
  beforeRequest?: (request: DaemonRpcRequest) => void | (() => void)
}

export function probeTerminalRoundTrip(timeoutMs = 8_000): Promise<DaemonTerminalProbe> {
  const nonce = `AGENT_OS_REMOTE_PTY_${randomBytes(12).toString('hex')}`
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    let child: ReturnType<typeof nodePty.spawn>
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve({
        ok: true,
        backend: 'node-pty',
        nodeVersion: process.versions.node,
        nodeAbi: process.versions.modules,
        platform: process.platform,
        arch: process.arch
      })
    }
    try {
      child = nodePty.spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(nonce)})`], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      })
    } catch (error) {
      reject(new Error(`远程 PTY 探针无法启动：${error instanceof Error ? error.message : String(error)}`))
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(new Error('远程 PTY 探针超时'))
    }, timeoutMs)
    child.onData((data) => {
      output = `${output}${data}`.slice(-4_096)
    })
    child.onExit(({ exitCode }) => {
      // 部分平台先发 exit、下一拍才冲刷最后一段 onData。
      setImmediate(() => {
        if (exitCode !== 0) finish(new Error(`远程 PTY 探针异常退出：${exitCode}`))
        else if (!output.includes(nonce)) finish(new Error('远程 PTY 探针未返回预期回显'))
        else finish()
      })
    })
  })
}

/** 处理一条 RPC 请求：hello/hostStatus 由端点合成，其余转发给 runtime 同名方法。 */
export async function dispatchRuntimeRpc(
  request: DaemonRpcRequest,
  options: RuntimeRpcServerOptions
): Promise<unknown> {
  if (
    typeof request.id !== 'string' ||
    request.id.length === 0 ||
    request.id.length > 120 ||
    !isDaemonRpcMethod(request.method) ||
    !Array.isArray(request.params) ||
    request.params.length > 4
  ) {
    throw new Error('无效 Runtime RPC 请求')
  }
  const finishRequest = options.beforeRequest?.(request)
  const runtime = options.runtime
  const params = request.params as unknown[]
  try {
    if (request.method === 'hello') {
      return {
        protocolVersion: options.protocolVersion,
        hostVersion: options.hostVersion,
        runtimeBuildId: options.runtimeBuildId
      }
    }
    if (request.method === 'hostStatus') {
      const status = await runtime.hostStatus()
      return {
        ...status,
        mode: 'daemon',
        connection: 'connected',
        protocolVersion: options.protocolVersion,
        hostVersion: options.hostVersion,
        runtimeBuildId: options.runtimeBuildId,
        pid: options.pid ?? process.pid,
        startedAt: options.startedAt
      }
    }
    if (request.method === 'probeTerminal') {
      return options.terminalProbe?.() ?? probeTerminalRoundTrip()
    }
    const method = runtime[request.method] as (...args: unknown[]) => Promise<unknown>
    return await method.apply(runtime, params)
  } finally {
    if (typeof finishRequest === 'function') finishRequest()
  }
}

/**
 * 把 RuntimeHost RPC 服务行为挂到一条已打开的 socket 上。返回 detach 清理函数。
 * 心跳按 socket 维度（每秒一次），与历史 server 端为每个 client 推心跳的行为一致。
 */
export function attachRuntimeRpcServer(
  socket: WebSocket,
  options: RuntimeRpcServerOptions
): () => void {
  const unsubscribe = options.runtime.subscribe((event) => {
    if (socket.readyState === WebSocket.OPEN) {
      const envelope: DaemonEnvelope = { type: 'event', event }
      socket.send(JSON.stringify(envelope))
    }
  })

  const onMessage = (data: unknown): void => {
    void (async () => {
      let request: DaemonRpcRequest | undefined
      try {
        const envelope = parseDaemonEnvelope(String(data))
        if (envelope.type !== 'request') return
        if (typeof envelope.id !== 'string' || envelope.id.length === 0 || envelope.id.length > 120) {
          socket.close(4400, 'Invalid RPC request')
          return
        }
        request = envelope
        const result = await dispatchRuntimeRpc(request, options)
        const response: DaemonRpcResponse = { type: 'response', id: request.id, result }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response))
      } catch (error) {
        if (!request) return
        const response: DaemonRpcResponse = {
          type: 'response',
          id: request.id,
          error: error instanceof Error ? error.message : String(error)
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response))
      }
    })()
  }
  socket.on('message', onMessage)

  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      const envelope: DaemonEnvelope = { type: 'heartbeat', at: Date.now() }
      socket.send(JSON.stringify(envelope))
    }
  }, 1_000)
  heartbeat.unref()

  const detach = (): void => {
    clearInterval(heartbeat)
    unsubscribe()
    socket.off('message', onMessage)
  }
  socket.once('close', detach)
  return detach
}
