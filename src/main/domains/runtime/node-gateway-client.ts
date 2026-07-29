// SPEC-032：远程节点出站拨号客户端。
// 节点不再监听端口，而是主动连回主控网关（wss://host:port/agent?token=…），
// 连上后用 attachRuntimeRpcServer 把本机 RuntimeHost 暴露给主控驱动；断线指数退避自动重连。
//
// 与主控的信任：URL token 证明节点被授权；可选 hostFingerprint 让节点 pin 主控自签证书（防中间人）。

import type { TLSSocket } from 'node:tls'
import { WebSocket, type ClientOptions } from 'ws'
import {
  attachRuntimeRpcServer,
  type RuntimeRpcServerOptions
} from './runtime-rpc-endpoint'
import {
  parseDaemonEnvelope,
  type DaemonNodeAdopted,
  type DaemonRegister
} from './daemon-protocol'

export type NodeGatewayState = 'connecting' | 'connected' | 'disconnected'

export interface NodeGatewayClientOptions {
  /** 主控网关地址，如 wss://192.168.1.20:7430/agent（token 会自动以 query 追加）。 */
  url: string
  /** 已登记节点的长期 token；首注册时可缺省。 */
  token?: string
  /** HTTP 脚本中的短期换票；只用于在 pin 证书的 WSS 中换取长期 token。 */
  enrollmentToken?: string
  /** 长期 token 落盘成功后 resolve；失败则不确认注册。 */
  onEnrollmentAccepted?: (nodeToken: string) => void | Promise<void>
  /** 可选：主控自签证书 SHA-256 指纹（大写冒号十六进制）；设置即 pin，不匹配拒连。 */
  hostFingerprint?: string
  /** 本机 RuntimeHost 及版本信息（暴露给主控驱动）。 */
  rpc: RuntimeRpcServerOptions
  /** 连上后上报的身份（label/platform 等）。 */
  register: Omit<DaemonRegister, 'type'>
  minBackoffMs?: number
  maxBackoffMs?: number
  adoptionTimeoutMs?: number
  /** 仅在主控完成 Runtime/PTY/Agent 探针并明确接管后触发。 */
  onAdopted?: (acknowledgement: DaemonNodeAdopted) => void | Promise<void>
  onStateChange?: (state: NodeGatewayState, error?: Error) => void
}

export interface NodeGatewayClient {
  close(): void
}

function peerFingerprint(socket: WebSocket): string | undefined {
  const tls = (socket as unknown as { _socket?: TLSSocket })._socket
  if (!tls || typeof tls.getPeerCertificate !== 'function') return undefined
  const cert = tls.getPeerCertificate()
  return cert && 'fingerprint256' in cert ? cert.fingerprint256 : undefined
}

export function startNodeGatewayClient(options: NodeGatewayClientOptions): NodeGatewayClient {
  const minBackoff = options.minBackoffMs ?? 1_000
  const maxBackoff = options.maxBackoffMs ?? 30_000
  let attempt = 0
  let closed = false
  let socket: WebSocket | null = null
  let detach: (() => void) | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let nodeToken = options.token
  let enrollmentToken = options.enrollmentToken
  // 这是 enrollment 整体生命周期状态，不能在每次重连时根据已换到的长期 token 重算；
  // 当前进程每次重连都补发回执，避免 send 后瞬断造成服务端未收到、客户端却永久跳过。
  const adoptionPersistenceConfirmationRequired = !nodeToken && Boolean(enrollmentToken)
  if (!nodeToken && !enrollmentToken) throw new Error('缺少节点 token 或 enrollment token')
  if (!nodeToken && !options.onEnrollmentAccepted) {
    throw new Error('首注册必须提供长期 token 持久化回调')
  }

  const scheduleReconnect = (error?: Error): void => {
    if (closed) return
    options.onStateChange?.('disconnected', error)
    const delay = Math.min(maxBackoff, minBackoff * 2 ** attempt)
    attempt += 1
    reconnectTimer = setTimeout(connect, delay)
    reconnectTimer.unref?.()
  }

  function connect(): void {
    if (closed) return
    options.onStateChange?.('connecting')
    const url = new URL(options.url)
    if (nodeToken) url.searchParams.set('token', nodeToken)
    else url.searchParams.set('enroll', enrollmentToken!)
    const secure = url.protocol === 'wss:'
    // 自签证书：用 rejectUnauthorized:false 完成 TLS，再在 open 后按指纹手动 pin。
    const wsOptions: ClientOptions | undefined = secure ? { rejectUnauthorized: false } : undefined
    const ws = wsOptions ? new WebSocket(url, wsOptions) : new WebSocket(url)
    socket = ws
    let enrollmentListener: ((data: unknown) => void) | null = null
    let adoptionListener: ((data: unknown) => void) | null = null
    let adoptionTimer: NodeJS.Timeout | null = null
    // 一次连接生命周期里只退避一次（error 与 close 可能都触发）。
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      if (enrollmentListener) ws.off('message', enrollmentListener)
      if (adoptionListener) ws.off('message', adoptionListener)
      if (adoptionTimer) clearTimeout(adoptionTimer)
      detach?.()
      detach = null
      scheduleReconnect(error)
    }

    ws.once('open', () => {
      if (secure && options.hostFingerprint) {
        const actual = peerFingerprint(ws)
        if (!actual || actual.toUpperCase() !== options.hostFingerprint.toUpperCase()) {
          ws.terminate()
          settle(
            new Error(`主控证书指纹不匹配：期望 ${options.hostFingerprint}，实际 ${actual ?? '无'}`)
          )
          return
        }
      }
      const registration: DaemonRegister = { type: 'register', ...options.register }
      const attach = (): void => {
        if (ws.readyState !== WebSocket.OPEN) return
        const expectedHostVersion = options.register.hostVersion ?? options.rpc.hostVersion
        adoptionListener = (data: unknown): void => {
          let acknowledgement: ReturnType<typeof parseDaemonEnvelope>
          try {
            acknowledgement = parseDaemonEnvelope(String(data))
          } catch {
            return
          }
          if (acknowledgement.type !== 'node-adopted') return
          if (!acknowledgement.nodeId ||
            acknowledgement.protocolVersion !== options.register.protocolVersion ||
            acknowledgement.hostVersion !== expectedHostVersion) {
            ws.terminate()
            settle(new Error('主控返回的节点接管确认与当前版本或协议不一致'))
            return
          }
          if (adoptionListener) ws.off('message', adoptionListener)
          adoptionListener = null
          if (adoptionTimer) clearTimeout(adoptionTimer)
          adoptionTimer = null
          attempt = 0
          void Promise.resolve()
            .then(() => options.onAdopted?.(acknowledgement))
            .then(() => {
              if (settled || ws.readyState !== WebSocket.OPEN) return
              if (adoptionPersistenceConfirmationRequired) {
                ws.send(JSON.stringify({
                  type: 'node-adopted-confirmed',
                  nodeId: acknowledgement.nodeId,
                  adoptedAt: acknowledgement.adoptedAt
                }))
              }
              options.onStateChange?.('connected')
            })
            .catch((error: unknown) => {
              ws.terminate()
              settle(error instanceof Error ? error : new Error(String(error)))
            })
        }
        ws.on('message', adoptionListener)
        adoptionTimer = setTimeout(() => {
          ws.terminate()
          settle(new Error('主控未在限时内完成节点 Runtime/PTY/Agent 接管确认'))
        }, options.adoptionTimeoutMs ?? 30_000)
        adoptionTimer.unref?.()
        detach = attachRuntimeRpcServer(ws, options.rpc)
      }
      if (nodeToken) {
        attach()
        ws.send(JSON.stringify(registration))
        return
      }

      enrollmentListener = (data: unknown): void => {
        let accepted: ReturnType<typeof parseDaemonEnvelope>
        try {
          accepted = parseDaemonEnvelope(String(data))
        } catch (error) {
          ws.terminate()
          settle(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (accepted.type !== 'enrollment-accepted') return
        if (!/^[a-f0-9]{64}$/i.test(accepted.nodeToken)) {
          ws.terminate()
          settle(new Error('主控返回了无效的节点 token'))
          return
        }
        if (enrollmentListener) ws.off('message', enrollmentListener)
        enrollmentListener = null
        void Promise.resolve()
          .then(() => options.onEnrollmentAccepted!(accepted.nodeToken))
          .then(() => {
            nodeToken = accepted.nodeToken
            enrollmentToken = undefined
            if (ws.readyState !== WebSocket.OPEN) return
            attach()
            ws.send(JSON.stringify({ type: 'enrollment-confirmed' }))
          })
          .catch((error: unknown) => {
            ws.terminate()
            settle(error instanceof Error ? error : new Error(String(error)))
          })
      }
      ws.on('message', enrollmentListener)
      ws.send(JSON.stringify(registration))
    })

    ws.once('close', () => settle())
    ws.once('error', (error) => settle(error instanceof Error ? error : new Error(String(error))))
  }

  connect()

  return {
    close(): void {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      detach?.()
      socket?.close()
    }
  }
}
