import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { RuntimeHost } from './protocol'
import { attachRuntimeRpcServer } from './runtime-rpc-endpoint'

export interface RuntimeDaemonServer {
  host: string
  port: number
  close(): Promise<void>
}

interface RuntimeDaemonServerOptions {
  runtime: RuntimeHost
  token: string
  hostVersion: string
  runtimeBuildId: string
  protocolVersion: number
  host: string
  port: number
  pid?: number
  startedAt?: string
}

interface RpcServerOptions extends RuntimeDaemonServerOptions {
  /** true=仅 loopback（本地 daemon，明文 ws）；false=允许 LAN（远程节点，需 TLS）。 */
  loopbackOnly: boolean
  /** 非 loopback 时必须提供，用于 WSS。 */
  tls?: { cert: string; key: string }
}

export function assertLoopbackAddress(host: string): void {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('daemon 仅允许绑定 localhost')
  }
}

function isLoopbackRemote(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function requestToken(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'ws://127.0.0.1').searchParams.get('token') ?? ''
  } catch {
    return ''
  }
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

/** 本地 daemon：仅 loopback、明文 ws，行为与历史一致。 */
export async function startRuntimeDaemonServer(
  options: RuntimeDaemonServerOptions
): Promise<RuntimeDaemonServer> {
  return startRpcServer({ ...options, loopbackOnly: true })
}

/**
 * 通用 RPC server。loopbackOnly=true 时等同本地 daemon；
 * loopbackOnly=false 时绑 LAN + WSS（必须带 tls），用于远程节点。token 校验始终生效。
 */
export async function startRpcServer(options: RpcServerOptions): Promise<RuntimeDaemonServer> {
  if (options.loopbackOnly) {
    assertLoopbackAddress(options.host)
  } else if (!options.tls) {
    throw new Error('远程 RPC server 必须启用 TLS')
  }
  const server = new WebSocketServer({ noServer: true })
  server.on('connection', (socket) => {
    // 服务行为（dispatch/事件推送/心跳）抽到传输无关的 attachRuntimeRpcServer，节点反向连接复用同一套。
    attachRuntimeRpcServer(socket, options)
  })

  const httpServer: import('node:http').Server = options.tls
    ? await import('node:https').then(({ createServer }) =>
        createServer({ cert: options.tls!.cert, key: options.tls!.key })
      )
    : await import('node:http').then(({ createServer }) => createServer())
  httpServer.on('upgrade', (request, socket, head) => {
    // 仅 loopback 模式才做本机来源闸门；远程节点靠 TLS + token 鉴权。
    if (options.loopbackOnly && !isLoopbackRemote(request)) {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    if (requestToken(request) !== options.token) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }
    server.handleUpgrade(request, socket, head, (webSocket) => {
      server.emit('connection', webSocket, request)
    })
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port, options.host, () => resolve())
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('daemon 端口分配失败')
  return {
    host: options.host,
    port: address.port,
    close: async () => {
      // 每条 socket 的心跳由 attachRuntimeRpcServer 在其 close 时各自清理。
      for (const socket of server.clients) socket.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      server.close()
    }
  }
}
