// SPEC-032：主控网关。节点反向拨回这里完成注册与受控。
// 两个监听：
//  - 明文 HTTP（默认 :7430）：只作为 enroll 脚本传输层；桌面复制命令内嵌脚本 SHA-256，目标机校验后才执行。
//  - WSS（默认 :7431，路径 /agent）：节点控制通道；token 鉴权，节点用脚本内嵌指纹 pin 本机证书。
// enroll 一次性、限时；首连消费后转为该节点的长期 token。

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { networkInterfaces } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { RUNTIME_PROTOCOL_VERSION, type CreateEnrollmentResult, type NodeEnrollment, type NodeGatewayStatus, type NodePlatform } from '@shared/types'
import { parseDaemonEnvelope, type DaemonRegister } from './daemon-protocol'
import {
  oneLiners,
  tokenId,
  unixInstallScript,
  powershellInstallScript,
  type InstallScriptParams
} from './node-install-scripts'

export const GATEWAY_MAX_PAYLOAD_BYTES = 1024 * 1024
export const PAIRING_MAX_PAYLOAD_BYTES = 64 * 1024
const ADOPTION_PERSISTENCE_CONFIRM_TIMEOUT_MS = 5_000

export interface ManagedGatewayCredential {
  type: 'managed-auth'
  authorizationId: string
  controllerDeviceId: string
  credential: string
}

export interface GatewayHooks {
  /** token → 已注册节点 id（重连）。无则 null。 */
  lookupNodeByToken(token: string): string | null
  /** 新节点首连：登记并返回 nodeId（实现方负责持久化 token）。 */
  registerNode(enrollment: NodeEnrollment, register: DaemonRegister): string
  /** 接管一条已认证的 node socket；仅在 hello/协议校验/RPC 初始化全部成功后 resolve。 */
  adopt(nodeId: string, socket: WebSocket, register: DaemonRegister): Promise<void>
  /** 新节点初始化失败时删除持久化记录和联邦 Host，避免留下半成品。 */
  rollbackNode(nodeId: string): Promise<void>
  /** 节点是否启用（禁用则拒连）。 */
  isNodeEnabled(nodeId: string): boolean
  /** 安装器确认时节点必须仍保持已完成 RPC 初始化的在线状态。 */
  isNodeConnected(nodeId: string): boolean
  /** GUI 受托管端：首帧凭证通过后，把受限 Runtime RPC 挂到 socket。 */
  adoptManaged?(socket: WebSocket, credential: ManagedGatewayCredential): Promise<void>
  /** GUI 配对端点：只在显式开启附近发现时接受有签名的短期握手。 */
  adoptPairing?(socket: WebSocket, remoteAddress: string): void
}

export interface NodeGatewayOptions {
  host?: string
  httpPort?: number
  wssPort?: number
  cert: string
  key: string
  fingerprint: string
  version: string
  repo: string
  enrollTtlMs?: number
  adoptionPersistenceConfirmTimeoutMs?: number
  advertiseHost?: string
}

/** 列出并排序可用于节点回连的本机 IPv4；物理网卡优先，VPN/容器/虚拟网卡降权。 */
export function lanAddressCandidates(): Array<{ interfaceName: string; address: string; recommended: boolean }> {
  const candidates: Array<{ interfaceName: string; address: string; score: number }> = []
  for (const [interfaceName, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const privateIp = /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address)
      const physical = /^(en\d+|eth\d+|wlan\d+|wi-?fi)$/i.test(interfaceName)
      const virtual = /^(utun|tun|tap|wg|docker|bridge|veth|vmnet|tailscale|llw|awdl)/i.test(interfaceName)
      candidates.push({ interfaceName, address: a.address, score: (privateIp ? 50 : 0) + (physical ? 30 : 0) - (virtual ? 80 : 0) })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.interfaceName.localeCompare(b.interfaceName))
  return candidates.map((item, index) => ({ interfaceName: item.interfaceName, address: item.address, recommended: index === 0 }))
}

export function lanAddress(preferred?: string): string {
  const candidates = lanAddressCandidates()
  if (preferred && candidates.some((item) => item.address === preferred)) return preferred
  return candidates[0]?.address || '127.0.0.1'
}

export class NodeGatewayServer {
  private http: HttpServer | null = null
  private https: HttpsServer | null = null
  private agentWss: WebSocketServer | null = null
  private managedWss: WebSocketServer | null = null
  private pairingWss: WebSocketServer | null = null
  private readonly enrollments = new Map<string, NodeEnrollment>()
  /** 安装器在守护启动后反查的主控确认；仅保留到 enrollment TTL 结束。 */
  private readonly completedEnrollments = new Map<string, { nodeId: string; completedAt: string }>()
  /** 同一短票只允许一个异步 register + adopt 流程，避免重连竞态产生重复节点。 */
  private readonly completingEnrollments = new Set<string>()
  private readonly managedSockets = new Map<string, Set<WebSocket>>()
  private readonly httpPort: number
  private readonly wssPort: number
  private readonly host: string
  private readonly enrollTtl: number
  private running = false

  constructor(
    private readonly options: NodeGatewayOptions,
    private readonly hooks: GatewayHooks
  ) {
    this.host = options.host ?? '0.0.0.0'
    this.httpPort = options.httpPort ?? 7430
    this.wssPort = options.wssPort ?? 7431
    this.enrollTtl = options.enrollTtlMs ?? 30 * 60_000
  }

  status(): NodeGatewayStatus {
    return {
      enabled: this.running,
      host: lanAddress(this.options.advertiseHost),
      port: this.httpPort,
      fingerprint: this.options.fingerprint,
      version: this.options.version,
      hostCandidates: lanAddressCandidates()
    }
  }

  private wsUrl(): string {
    return `wss://${lanAddress(this.options.advertiseHost)}:${this.wssPort}/agent`
  }
  private httpBase(): string {
    return `http://${lanAddress(this.options.advertiseHost)}:${this.httpPort}`
  }

  private scriptParams(
    enrollmentToken: string,
    expectedPlatform?: NodePlatform,
    assetSha256?: string
  ): InstallScriptParams {
    return {
      httpBase: this.httpBase(),
      wsUrl: this.wsUrl(),
      enrollmentToken,
      fingerprint: this.options.fingerprint,
      version: this.options.version,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      repo: this.options.repo,
      expectedPlatform,
      assetSha256
    }
  }

  createEnrollment(label?: string, platform?: NodePlatform, assetSha256?: string): CreateEnrollmentResult {
    this.sweepEnrollments()
    const enrollmentToken = randomBytes(32).toString('hex')
    const nodeToken = randomBytes(32).toString('hex')
    const enrollId = tokenId(enrollmentToken)
    const now = Date.now()
    const enrollment: NodeEnrollment = {
      enrollId,
      enrollmentToken,
      nodeToken,
      label: label?.trim() || '远程节点',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.enrollTtl).toISOString(),
      platform,
      assetSha256
    }
    this.enrollments.set(enrollId, enrollment)
    return {
      enrollId,
      hostAddress: `${lanAddress(this.options.advertiseHost)}:${this.httpPort}`,
      commands: oneLiners(this.scriptParams(enrollmentToken, platform, assetSha256)),
      expiresAt: enrollment.expiresAt,
      platform
    }
  }

  private sweepEnrollments(): void {
    const now = Date.now()
    for (const [id, e] of this.enrollments) {
      if (Date.parse(e.expiresAt) >= now) continue
      this.enrollments.delete(id)
      this.completedEnrollments.delete(id)
    }
  }

  async start(): Promise<NodeGatewayStatus> {
    if (this.running) return this.status()
    try {
      // 1) 明文 HTTP：enroll 脚本下载；真实性由桌面命令锚定的 SHA-256 保证。
      this.http = createHttpServer((req, res) => this.handleHttp(req, res))
      await listen(this.http, this.httpPort, this.host)

      // 2) WSS：节点控制通道。
      this.https = createHttpsServer({ cert: this.options.cert, key: this.options.key })
      // 旧 /agent 维持既有兼容上限；只有暴露给 GUI 控制端的 /managed 收紧单帧大小。
      this.agentWss = new WebSocketServer({ noServer: true })
      this.managedWss = new WebSocketServer({ noServer: true, maxPayload: GATEWAY_MAX_PAYLOAD_BYTES })
      this.pairingWss = new WebSocketServer({ noServer: true, maxPayload: PAIRING_MAX_PAYLOAD_BYTES })
      this.https.on('upgrade', (request, socket, head) => {
        try {
          const url = new URL(request.url ?? '/', 'https://127.0.0.1')
          if (url.pathname === '/managed' && this.hooks.adoptManaged) {
            // 长期凭证不得进入 URL/代理日志；升级后只从第一条 WebSocket 消息读取。
            if (url.search) return rejectUpgrade(socket, '400 Bad Request')
            this.managedWss!.handleUpgrade(request, socket, head, (ws) => {
              guardWebSocketErrors(ws)
              this.onManagedSocket(ws)
            })
            return
          }
          if (url.pathname === '/pairing' && this.hooks.adoptPairing) {
            if (url.search) return rejectUpgrade(socket, '400 Bad Request')
            this.pairingWss!.handleUpgrade(request, socket, head, (ws) => {
              guardWebSocketErrors(ws)
              this.hooks.adoptPairing!(ws, normalizeRemoteAddress(request.socket.remoteAddress))
            })
            return
          }
          if (url.pathname !== '/agent') return rejectUpgrade(socket, '404 Not Found')
          const nodeToken = url.searchParams.get('token') ?? ''
          const enrollmentToken = url.searchParams.get('enroll') ?? ''
          const resolved = this.resolveCredential(
            nodeToken,
            enrollmentToken,
            normalizeRemoteAddress(request.socket.remoteAddress)
          )
          if (!resolved) return rejectUpgrade(socket, '401 Unauthorized')
          this.agentWss!.handleUpgrade(request, socket, head, (ws) => {
            guardWebSocketErrors(ws)
            this.onNodeSocket(ws, resolved)
          })
        } catch {
          rejectUpgrade(socket, '400 Bad Request')
        }
      })
      await listen(this.https, this.wssPort, this.host)
      this.running = true
      return this.status()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.running = false
    for (const ws of this.agentWss?.clients ?? []) ws.close()
    for (const ws of this.managedWss?.clients ?? []) ws.close()
    for (const ws of this.pairingWss?.clients ?? []) ws.close()
    this.agentWss?.close()
    this.managedWss?.close()
    this.pairingWss?.close()
    await closeServer(this.https)
    await closeServer(this.http)
    this.agentWss = null
    this.managedWss = null
    this.pairingWss = null
    this.https = null
    this.http = null
    this.managedSockets.clear()
  }

  disconnectManagedAuthorization(authorizationId: string): void {
    const sockets = this.managedSockets.get(authorizationId)
    if (!sockets) return
    this.managedSockets.delete(authorizationId)
    for (const socket of sockets) socket.close(4403, 'Authorization inactive')
  }

  private onManagedSocket(ws: WebSocket): void {
    const timer = setTimeout(() => ws.close(4401, 'Authentication timeout'), 3_000)
    ws.once('close', () => clearTimeout(timer))
    ws.once('message', (raw) => {
      clearTimeout(timer)
      const credential = parseManagedGatewayCredential(String(raw))
      if (!credential || !this.hooks.adoptManaged) {
        ws.close(4401, 'Unauthorized')
        return
      }
      const sockets = this.managedSockets.get(credential.authorizationId) ?? new Set<WebSocket>()
      sockets.add(ws)
      this.managedSockets.set(credential.authorizationId, sockets)
      const forget = (): void => {
        sockets.delete(ws)
        if (
          sockets.size === 0 &&
          this.managedSockets.get(credential.authorizationId) === sockets
        ) this.managedSockets.delete(credential.authorizationId)
      }
      ws.once('close', forget)
      void this.hooks.adoptManaged(ws, credential)
        .then(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          // 一条方向性授权只保留一条当前控制连接；合法重连替换旧 socket。
          for (const other of sockets) {
            if (other !== ws) other.close(4400, 'Replaced by reconnect')
          }
          sockets.clear()
          sockets.add(ws)
          ws.send(JSON.stringify({
            type: 'managed-authenticated',
            authorizationId: credential.authorizationId,
            protocolVersion: RUNTIME_PROTOCOL_VERSION
          }))
        })
        .catch(() => ws.close(4401, 'Unauthorized'))
    })
  }

  private handleHttp(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ): void {
    this.sweepEnrollments()
    const rawUrl = req.url ?? '/'
    const statusMatch = /^\/enroll\/([A-Za-z0-9]+?)\/status$/.exec(rawUrl.split('?')[0])
    if (statusMatch) {
      this.handleEnrollmentStatus(req, res, statusMatch[1])
      return
    }
    const m = /^\/enroll\/([A-Za-z0-9]+?)(\.ps1)?$/.exec(rawUrl.split('?')[0])
    if (!m) {
      res.writeHead(404).end('not found')
      return
    }
    const enrollment = this.enrollments.get(m[1])
    if (!enrollment || enrollment.consumedAt) {
      res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('该接入命令已失效，请在 Agent OS 重新生成。')
      return
    }
    const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress)
    if (enrollment.deliveredTo && enrollment.deliveredTo !== remoteAddress) {
      res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('该接入命令已由另一台主机领取，请在 Agent OS 重新生成。')
      return
    }
    enrollment.deliveredTo = remoteAddress
    const params = this.scriptParams(
      enrollment.enrollmentToken,
      enrollment.platform,
      enrollment.assetSha256
    )
    const body = m[2] ? powershellInstallScript(params) : unixInstallScript(params)
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(body)
  }

  /**
   * 短票只在同一台领取主机上作为 Bearer 使用；返回 registered 代表：
   * 节点已 pin WSS 证书、原子持久化长期 token、上报 register，且主控已 adopt socket。
   */
  private handleEnrollmentStatus(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    enrollId: string
  ): void {
    const enrollment = this.enrollments.get(enrollId)
    if (!enrollment) {
      this.sendEnrollmentStatus(res, 410, { status: 'expired' })
      return
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''
    if (!safeSecretEqual(bearer, enrollment.enrollmentToken)) {
      this.sendEnrollmentStatus(res, 401, { status: 'unauthorized' })
      return
    }
    const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress)
    if (enrollment.deliveredTo && enrollment.deliveredTo !== remoteAddress) {
      this.sendEnrollmentStatus(res, 409, { status: 'claimed-by-another-host' })
      return
    }
    const completion = this.completedEnrollments.get(enrollId)
    if (!completion || !this.hooks.isNodeConnected(completion.nodeId)) {
      this.sendEnrollmentStatus(res, 202, { status: 'pending' })
      return
    }
    this.sendEnrollmentStatus(res, 200, {
      status: 'registered',
      nodeId: completion.nodeId,
      completedAt: completion.completedAt
    })
  }

  private sendEnrollmentStatus(
    res: import('node:http').ServerResponse,
    statusCode: number,
    payload: Record<string, string>
  ): void {
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  }

  private resolveCredential(
    nodeToken: string,
    enrollmentToken: string,
    remoteAddress: string
  ):
    | { kind: 'node'; nodeId: string }
    | { kind: 'pending-node'; enrollment: NodeEnrollment }
    | { kind: 'enroll'; enrollment: NodeEnrollment }
    | null {
    if (nodeToken) {
      this.sweepEnrollments()
      const pending = [...this.enrollments.values()].find((item) => item.nodeToken === nodeToken)
      // registerNode 可能已把长期 token 写入 registry，但 enrollment 尚未完成 adopted
      // 持久化回执；必须优先走 pending-node，不能误按普通重连提前放行。
      if (pending && !pending.consumedAt) return { kind: 'pending-node', enrollment: pending }
      const nodeId = this.hooks.lookupNodeByToken(nodeToken)
      return nodeId && this.hooks.isNodeEnabled(nodeId) ? { kind: 'node', nodeId } : null
    }
    if (!enrollmentToken) return null
    this.sweepEnrollments()
    const enrollment = [...this.enrollments.values()].find(
      (item) => item.enrollmentToken === enrollmentToken && !item.consumedAt
    )
    if (!enrollment || !enrollment.deliveredTo || enrollment.deliveredTo !== remoteAddress) return null
    return { kind: 'enroll', enrollment }
  }

  private onNodeSocket(
    ws: WebSocket,
    resolved:
      | { kind: 'node'; nodeId: string }
      | { kind: 'pending-node'; enrollment: NodeEnrollment }
      | { kind: 'enroll'; enrollment: NodeEnrollment }
  ): void {
    // 等首帧 register（3s 超时）。
    const timer = setTimeout(() => ws.close(), 3_000)
    ws.once('message', (raw) => {
      clearTimeout(timer)
      let register: DaemonRegister
      try {
        const env = parseDaemonEnvelope(String(raw))
        if (env.type !== 'register') return ws.close()
        register = env
      } catch {
        return ws.close()
      }
      if (resolved.kind === 'node') {
        void this.hooks.adopt(resolved.nodeId, ws, register)
          .then(() => this.sendNodeAdopted(ws, resolved.nodeId, register))
          .catch(() => ws.close())
        return
      }
      if (resolved.kind === 'pending-node') {
        void this.completeEnrollment(resolved.enrollment, register, ws)
        return
      }

      // HTTP 脚本只携带短期换票。长期 token 在证书指纹已 pin 的 WSS 内下发，
      // 并且等节点原子持久化后再消费 enrollment。
      ws.send(JSON.stringify({ type: 'enrollment-accepted', nodeToken: resolved.enrollment.nodeToken }))
      const confirmTimer = setTimeout(() => ws.close(), 5_000)
      ws.once('message', (confirmationRaw) => {
        clearTimeout(confirmTimer)
        try {
          const confirmation = parseDaemonEnvelope(String(confirmationRaw))
          if (confirmation.type !== 'enrollment-confirmed') return ws.close()
          void this.completeEnrollment(resolved.enrollment, register, ws)
        } catch {
          ws.close()
        }
      })
    })
  }

  private async completeEnrollment(
    enrollment: NodeEnrollment,
    register: DaemonRegister,
    ws: WebSocket
  ): Promise<void> {
    if (this.completingEnrollments.has(enrollment.enrollId)) {
      ws.close()
      return
    }
    this.completingEnrollments.add(enrollment.enrollId)
    let nodeId: string | null = null
    try {
      nodeId = this.hooks.registerNode(enrollment, register)
      await this.hooks.adopt(nodeId, ws, register)
      const completedAt = new Date().toISOString()
      await this.sendNodeAdoptedAndWaitForPersistence(ws, nodeId, register, completedAt)
      enrollment.consumedAt = completedAt
      this.completedEnrollments.set(enrollment.enrollId, { nodeId, completedAt })
    } catch {
      if (nodeId) await this.hooks.rollbackNode(nodeId).catch(() => undefined)
      ws.close()
    } finally {
      this.completingEnrollments.delete(enrollment.enrollId)
    }
  }

  private async sendNodeAdoptedAndWaitForPersistence(
    ws: WebSocket,
    nodeId: string,
    register: DaemonRegister,
    adoptedAt: string
  ): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('节点在接管确认前已断开')
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timer)
        ws.off('message', onMessage)
        ws.off('close', onClose)
      }
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const onClose = (): void => finish(new Error('节点在本地持久化确认前已断开'))
      const onMessage = (raw: unknown): void => {
        let confirmation: ReturnType<typeof parseDaemonEnvelope>
        try {
          confirmation = parseDaemonEnvelope(String(raw))
        } catch {
          return
        }
        if (confirmation.type !== 'node-adopted-confirmed') return
        if (confirmation.nodeId !== nodeId || confirmation.adoptedAt !== adoptedAt) {
          finish(new Error('节点本地持久化确认与本次接管不一致'))
          return
        }
        finish()
      }
      const timer = setTimeout(
        () => finish(new Error('节点未在限时内确认本地持久化')),
        this.options.adoptionPersistenceConfirmTimeoutMs ?? ADOPTION_PERSISTENCE_CONFIRM_TIMEOUT_MS
      )
      timer.unref?.()
      ws.on('message', onMessage)
      ws.once('close', onClose)
      this.sendNodeAdopted(ws, nodeId, register, adoptedAt)
    })
  }

  private sendNodeAdopted(
    ws: WebSocket,
    nodeId: string,
    register: DaemonRegister,
    adoptedAt = new Date().toISOString()
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'node-adopted',
      nodeId,
      hostVersion: register.hostVersion ?? this.options.version,
      protocolVersion: register.protocolVersion,
      adoptedAt
    }))
  }
}

function parseManagedGatewayCredential(raw: string): ManagedGatewayCredential | null {
  try {
    const value = JSON.parse(raw) as Partial<ManagedGatewayCredential>
    if (value.type !== 'managed-auth') return null
    if (typeof value.authorizationId !== 'string' || !value.authorizationId || value.authorizationId.length > 120) return null
    if (typeof value.controllerDeviceId !== 'string' || !value.controllerDeviceId || value.controllerDeviceId.length > 120) return null
    if (typeof value.credential !== 'string' || !/^[a-f0-9]{64}$/i.test(value.credential)) return null
    return {
      type: 'managed-auth',
      authorizationId: value.authorizationId,
      controllerDeviceId: value.controllerDeviceId,
      credential: value.credential
    }
  } catch {
    return null
  }
}

function guardWebSocketErrors(socket: WebSocket): void {
  // `ws` 会先用正确 close code（如超限帧 1009）收口，再发 error；必须消费以免主进程崩溃。
  socket.on('error', () => undefined)
}

function safeSecretEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function normalizeRemoteAddress(address?: string): string {
  if (!address) return ''
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function listen(server: HttpServer | HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: HttpServer | HttpsServer | null): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}
