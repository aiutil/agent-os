// SPEC-032 Step J3：GUI 控制端连接另一台 GUI 的 /managed WSS。
// 长期凭证只发在首帧；TLS 使用配对时确认的 SHA-256 证书指纹 pin；断线指数退避重连。

import type { TLSSocket } from 'node:tls'
import { WebSocket, type ClientOptions } from 'ws'
import {
  RUNTIME_PROTOCOL_VERSION,
  type RemoteNode,
  type RemoteNodeStatus
} from '@shared/types'
import { RemoteRuntimeHost } from './remote-runtime-host'

export type ManagedGatewayClientState = 'connecting' | 'connected' | 'disconnected'

export interface ManagedGatewayClientOptions {
  hostId: string
  label: string
  url: string
  certificateFingerprint: string
  authorizationId: string
  controllerDeviceId: string
  credential: string
  minBackoffMs?: number
  maxBackoffMs?: number
  authenticationTimeoutMs?: number
  runtimeInitializationTimeoutMs?: number
  onStateChange?: (state: ManagedGatewayClientState, error?: Error) => void
  onRuntimeStatus?: (status: RemoteNodeStatus) => void
}

export interface ManagedGatewayClient {
  runtime: RemoteRuntimeHost
  close(): Promise<void>
}

function peerFingerprint(socket: WebSocket): string | undefined {
  const tls = (socket as unknown as { _socket?: TLSSocket })._socket
  if (!tls || typeof tls.getPeerCertificate !== 'function') return undefined
  const cert = tls.getPeerCertificate()
  return cert && 'fingerprint256' in cert ? cert.fingerprint256 : undefined
}

export function validateManagedGatewayClientOptions(options: ManagedGatewayClientOptions): URL {
  const url = new URL(options.url)
  if (url.protocol !== 'wss:') throw new Error('GUI 受托管连接必须使用 wss://')
  if (url.pathname !== '/managed' || url.search || url.hash || url.username || url.password) {
    throw new Error('GUI 受托管连接地址必须是无凭证、无查询参数的 /managed WSS')
  }
  if (!/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i.test(options.certificateFingerprint)) {
    throw new Error('GUI 受托管端证书指纹无效')
  }
  if (!options.authorizationId || options.authorizationId.length > 120) throw new Error('方向性授权 id 无效')
  if (!options.controllerDeviceId || options.controllerDeviceId.length > 120) throw new Error('控制端 deviceId 无效')
  if (!/^[a-f0-9]{64}$/i.test(options.credential)) throw new Error('方向性授权凭证无效')
  return url
}

export function startManagedGatewayClient(options: ManagedGatewayClientOptions): ManagedGatewayClient {
  const url = validateManagedGatewayClientOptions(options)
  const minBackoff = options.minBackoffMs ?? 1_000
  const maxBackoff = options.maxBackoffMs ?? 30_000
  const node: RemoteNode = {
    id: options.hostId,
    label: options.label,
    host: url.hostname,
    port: Number(url.port || 443),
    token: '',
    fingerprint: options.certificateFingerprint,
    enabled: true,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    addedAt: new Date().toISOString()
  }
  const runtime = new RemoteRuntimeHost(node, options.onRuntimeStatus, { probeTerminal: false })
  let attempt = 0
  let stopped = false
  let socket: WebSocket | null = null
  let reconnectTimer: NodeJS.Timeout | null = null

  const scheduleReconnect = (error?: Error): void => {
    if (stopped) return
    options.onStateChange?.('disconnected', error)
    const delay = Math.min(maxBackoff, minBackoff * 2 ** attempt)
    attempt += 1
    reconnectTimer = setTimeout(connect, delay)
    reconnectTimer.unref?.()
  }

  function connect(): void {
    if (stopped) return
    reconnectTimer = null
    options.onStateChange?.('connecting')
    const wsOptions: ClientOptions = { rejectUnauthorized: false }
    const ws = new WebSocket(url, wsOptions)
    socket = ws
    let settled = false
    let authTimer: NodeJS.Timeout | null = null
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      if (authTimer) clearTimeout(authTimer)
      scheduleReconnect(error)
    }

    ws.once('open', () => {
      const actual = peerFingerprint(ws)
      if (!actual || actual.toUpperCase() !== options.certificateFingerprint.toUpperCase()) {
        ws.terminate()
        settle(new Error(
          `受托管端证书指纹不匹配：期望 ${options.certificateFingerprint}，实际 ${actual ?? '无'}`
        ))
        return
      }
      const onAuthentication = (raw: unknown): void => {
        let message: { type?: unknown; authorizationId?: unknown; protocolVersion?: unknown }
        try {
          message = JSON.parse(String(raw)) as typeof message
        } catch {
          return
        }
        if (message.type !== 'managed-authenticated') return
        if (
          message.authorizationId !== options.authorizationId ||
          message.protocolVersion !== RUNTIME_PROTOCOL_VERSION
        ) {
          ws.terminate()
          settle(new Error('受托管端认证确认与当前授权或协议不一致'))
          return
        }
        ws.off('message', onAuthentication)
        if (authTimer) clearTimeout(authTimer)
        authTimer = null
        const initializeRuntime = runtime.adoptConnection(ws)
        const initializationTimeout = new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('GUI 受托管 Runtime 初始化超时')),
            options.runtimeInitializationTimeoutMs ?? 10_000
          )
          timer.unref?.()
          void initializeRuntime.then(
            () => clearTimeout(timer),
            () => clearTimeout(timer)
          )
        })
        void Promise.race([initializeRuntime, initializationTimeout]).then(() => {
          if (stopped || socket !== ws || ws.readyState !== WebSocket.OPEN) return
          if (runtime.status().connection !== 'connected') {
            ws.terminate()
            settle(new Error(runtime.status().error || 'GUI 受托管 Runtime 初始化失败'))
            return
          }
          attempt = 0
          options.onStateChange?.('connected')
        }).catch((error: unknown) => {
          ws.terminate()
          settle(error instanceof Error ? error : new Error(String(error)))
        })
      }
      ws.on('message', onAuthentication)
      authTimer = setTimeout(() => {
        ws.terminate()
        settle(new Error('受托管端首帧认证超时'))
      }, options.authenticationTimeoutMs ?? 5_000)
      authTimer.unref?.()
      ws.send(JSON.stringify({
        type: 'managed-auth',
        authorizationId: options.authorizationId,
        controllerDeviceId: options.controllerDeviceId,
        credential: options.credential
      }))
    })
    ws.once('close', () => settle())
    ws.once('error', (error) => settle(error instanceof Error ? error : new Error(String(error))))
  }

  connect()
  return {
    runtime,
    async close(): Promise<void> {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const current = socket
      const closed = !current || current.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => current.once('close', () => resolve()))
      if (current?.readyState === WebSocket.CONNECTING) current.terminate()
      else current?.close()
      await Promise.all([runtime.close(), closed])
      socket = null
    }
  }
}
