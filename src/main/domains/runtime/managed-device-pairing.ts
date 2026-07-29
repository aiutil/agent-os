// SPEC-032 Step J4：GUI 设备附近发现与单向配对。
// mDNS 只广播临时摘要；稳定身份、公钥、短码和长期凭证只在 WSS 握手内传输。

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { TLSSocket } from 'node:tls'
import Bonjour from 'bonjour-service'
import { WebSocket } from 'ws'
import {
  MANAGED_PAIRING_PROTOCOL_VERSION,
  MANAGED_PAIRING_TTL_MS,
  type ApproveManagedPairingInput,
  type ManagedDeviceIdentity,
  type ManagedPairingSession,
  type ManagedPairingSnapshot,
  type NearbyManagedDevice
} from '@shared/types'
import type { DeviceAuthorizationRegistry } from './device-authorization'
import { devicePublicKeyFingerprint, verifyDeviceSignature } from './device-authorization'
import type { CreateManagedDeviceConnectionInput, ManagedDeviceConnection } from '@shared/types'

const SERVICE_TYPE = 'agentos-pair'
const MAX_PAIRING_ATTEMPTS = 5
const ATTEMPT_WINDOW_MS = 60_000
export const PAIRING_ACK_TIMEOUT_MS = 10_000
export const MAX_PAIRING_CLOCK_SKEW_MS = 60_000

export interface ManagedPairingEndpoint {
  host: string
  port: number
  certificateFingerprint: string
}

export interface ManagedPairingDiscoveryTransport {
  start(onUp: (device: NearbyManagedDevice) => void, onDown: (discoveryId: string) => void): void
  advertise(device: NearbyManagedDevice): void
  stopAdvertising(): void
  close(): void
}

interface PairingControllerRegistry {
  list(): ManagedDeviceConnection[]
  add(input: CreateManagedDeviceConnectionInput): ManagedDeviceConnection
  setEnabled(id: string, enabled: boolean): Promise<ManagedDeviceConnection>
  remove(id: string): Promise<void>
}

interface InternalSession extends ManagedPairingSession {
  socket: WebSocket
  requestId: string
  clientNonce: string
  serverNonce: string
  peerIdentity: ManagedDeviceIdentity
  createdAuthorizationId?: string
  ackTimer?: NodeJS.Timeout
  expiryTimer?: NodeJS.Timeout
}

type PairRequest = {
  type: 'pair-request'
  requestId: string
  clientNonce: string
  controller: ManagedDeviceIdentity
  signature: string
}

function requestTranscript(requestId: string, nonce: string, identity: ManagedDeviceIdentity): string {
  return ['agentos-pair-request-v1', requestId, nonce, identity.deviceId, identity.publicKey].join('\n')
}

function confirmTranscript(session: InternalSession): string {
  return [
    'agentos-pair-confirm-v1',
    session.id,
    session.requestId,
    session.clientNonce,
    session.serverNonce,
    session.shortCode
  ].join('\n')
}

function peerFingerprint(socket: WebSocket): string | undefined {
  const tls = (socket as unknown as { _socket?: TLSSocket })._socket
  if (!tls || typeof tls.getPeerCertificate !== 'function') return undefined
  return tls.getPeerCertificate()?.fingerprint256
}

function parseMessage(raw: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function safeIdentity(value: unknown): ManagedDeviceIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const identity = value as Record<string, unknown>
  if (
    identity.schemaVersion !== 1 ||
    typeof identity.deviceId !== 'string' || identity.deviceId.length > 128 ||
    typeof identity.displayName !== 'string' || !identity.displayName.trim() || identity.displayName.length > 120 ||
    typeof identity.publicKey !== 'string' || identity.publicKey.length > 2_000 ||
    typeof identity.publicKeyFingerprint !== 'string' ||
    typeof identity.createdAt !== 'string'
  ) return null
  try {
    if (devicePublicKeyFingerprint(identity.publicKey) !== identity.publicKeyFingerprint) return null
  } catch {
    return null
  }
  return identity as unknown as ManagedDeviceIdentity
}

function shortCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

function publicSession(session: InternalSession): ManagedPairingSession {
  const { socket: _socket, requestId: _requestId, clientNonce: _clientNonce,
    serverNonce: _serverNonce, peerIdentity: _peerIdentity,
    createdAuthorizationId: _createdAuthorizationId, ackTimer: _ackTimer,
    expiryTimer: _expiryTimer, ...view } = session
  return view
}

function managedUrl(endpoint: ManagedPairingEndpoint): string {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
  return `wss://${host}:${endpoint.port}/managed`
}

class BonjourDiscoveryTransport implements ManagedPairingDiscoveryTransport {
  private bonjour: Bonjour | null = null
  private browser: ReturnType<Bonjour['find']> | null = null
  private service: ReturnType<Bonjour['publish']> | null = null

  start(onUp: (device: NearbyManagedDevice) => void, onDown: (discoveryId: string) => void): void {
    if (this.bonjour) return
    this.bonjour = new Bonjour(undefined, () => undefined)
    this.browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: 'tcp' })
    this.browser.on('up', (service) => {
      const txt = service.txt as Record<string, unknown> | undefined
      const discoveryId = String(txt?.id ?? '')
      const protocolVersion = Number(txt?.v)
      const address = service.referer?.address || service.addresses?.find((item) => item.includes('.')) || ''
      if (!/^[a-f0-9]{16}$/i.test(discoveryId) || !address || protocolVersion !== MANAGED_PAIRING_PROTOCOL_VERSION) return
      onUp({
        discoveryId,
        displayName: String(txt?.name ?? service.name).slice(0, 120),
        platform: String(txt?.platform ?? 'unknown').slice(0, 40),
        host: address,
        port: service.port,
        protocolVersion,
        lastSeenAt: new Date().toISOString()
      })
    })
    this.browser.on('down', (service) => {
      const discoveryId = String((service.txt as Record<string, unknown> | undefined)?.id ?? '')
      if (discoveryId) onDown(discoveryId)
    })
  }

  advertise(device: NearbyManagedDevice): void {
    if (!this.bonjour) return
    this.stopAdvertising()
    this.service = this.bonjour.publish({
      name: `Agent OS ${device.discoveryId}`,
      type: SERVICE_TYPE,
      protocol: 'tcp',
      port: device.port,
      disableIPv6: true,
      txt: {
        id: device.discoveryId,
        name: device.displayName,
        platform: device.platform,
        v: String(device.protocolVersion)
      }
    })
  }

  stopAdvertising(): void {
    this.service?.stop()
    this.service = null
  }

  close(): void {
    this.stopAdvertising()
    this.browser?.stop()
    this.browser = null
    this.bonjour?.destroy()
    this.bonjour = null
  }
}

export interface ManagedDevicePairingOptions {
  authorizations: DeviceAuthorizationRegistry
  controllers: PairingControllerRegistry
  getEndpoint: () => ManagedPairingEndpoint | null
  discovery?: ManagedPairingDiscoveryTransport
  now?: () => Date
  platform?: string
  ackTimeoutMs?: number
}

export class ManagedDevicePairingService {
  private readonly discovery: ManagedPairingDiscoveryTransport
  private readonly nearby = new Map<string, NearbyManagedDevice>()
  private readonly sessions = new Map<string, InternalSession>()
  private readonly attempts = new Map<string, number[]>()
  private readonly now: () => Date
  private readonly startupSalt = randomBytes(16).toString('hex')
  private discoverable = false
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: ManagedDevicePairingOptions) {
    this.discovery = options.discovery ?? new BonjourDiscoveryTransport()
    this.now = options.now ?? (() => new Date())
  }

  init(discoverable: boolean): void {
    this.discovery.start(
      (device) => {
        if (device.discoveryId !== this.discoveryId()) this.nearby.set(device.discoveryId, device)
      },
      (id) => this.nearby.delete(id)
    )
    this.setDiscoverable(discoverable)
  }

  setDiscoverable(enabled: boolean): void {
    if (enabled && !this.options.getEndpoint()) throw new Error('远程托管网关未启动')
    this.discoverable = enabled
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    if (!enabled) {
      this.discovery.stopAdvertising()
      return
    }
    this.publish()
    this.refreshTimer = setInterval(() => this.publish(), 60_000)
    this.refreshTimer.unref?.()
  }

  snapshot(): ManagedPairingSnapshot {
    this.sweep()
    const endpoint = this.options.getEndpoint()
    return {
      discoverable: this.discoverable,
      ...(endpoint ? { manualEndpoint: `${endpoint.host}:${endpoint.port}` } : {}),
      identity: this.options.authorizations.identity(),
      nearbyDevices: [...this.nearby.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      sessions: [...this.sessions.values()].map(publicSession),
      inboundAuthorizations: this.options.authorizations.list().filter(
        (authorization) => !this.isPendingAuthorization(authorization.id)
      ),
      outboundConnections: this.options.controllers.list()
    }
  }

  async request(discoveryId: string): Promise<ManagedPairingSession> {
    const device = this.nearby.get(discoveryId)
    if (!device) throw new Error('附近设备已离线，请重新扫描')
    return this.requestEndpoint(device.host, device.port)
  }

  async requestManual(value: string): Promise<ManagedPairingSession> {
    const endpoint = value.trim().replace(/^wss:\/\//, '').replace(/\/pairing\/?$/, '')
    const url = new URL(`wss://${endpoint}/pairing`)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/pairing') {
      throw new Error('手工地址必须是 host:port，不能包含凭证或查询参数')
    }
    return this.requestEndpoint(url.hostname, Number(url.port || 7431))
  }

  accept(socket: WebSocket, remoteAddress: string): void {
    if (!this.discoverable || !this.allowAttempt(remoteAddress)) {
      socket.close(4429, 'Pairing unavailable')
      return
    }
    const timer = setTimeout(() => socket.close(4408, 'Pairing request timeout'), 5_000)
    timer.unref?.()
    socket.once('message', (raw) => {
      clearTimeout(timer)
      const request = parseMessage(raw) as PairRequest | null
      const controller = safeIdentity(request?.controller)
      if (
        request?.type !== 'pair-request' || !controller ||
        typeof request.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.requestId) ||
        typeof request.clientNonce !== 'string' || !/^[a-f0-9]{64}$/i.test(request.clientNonce) ||
        typeof request.signature !== 'string' ||
        !verifyDeviceSignature(
          controller.publicKey,
          requestTranscript(request.requestId, request.clientNonce, controller),
          request.signature
        )
      ) {
        socket.close(4401, 'Invalid signed pairing request')
        return
      }
      if (controller.deviceId === this.options.authorizations.identity().deviceId) {
        socket.close(4400, 'Cannot pair with self')
        return
      }
      const endpoint = this.options.getEndpoint()
      if (!endpoint) {
        socket.close(4410, 'Gateway unavailable')
        return
      }
      const session: InternalSession = {
        id: randomUUID(),
        role: 'managed',
        state: 'requested',
        peerDeviceId: controller.deviceId,
        peerDisplayName: controller.displayName,
        peerPublicKeyFingerprint: controller.publicKeyFingerprint,
        certificateFingerprint: endpoint.certificateFingerprint,
        shortCode: shortCode(),
        expiresAt: new Date(this.now().getTime() + MANAGED_PAIRING_TTL_MS).toISOString(),
        socket,
        requestId: request.requestId,
        clientNonce: request.clientNonce,
        serverNonce: randomBytes(32).toString('hex'),
        peerIdentity: controller
      }
      this.sessions.set(session.id, session)
      this.armExpiry(session)
      socket.send(JSON.stringify({
        type: 'pair-challenge',
        sessionId: session.id,
        managed: this.options.authorizations.identity(),
        certificateFingerprint: endpoint.certificateFingerprint,
        shortCode: session.shortCode,
        serverNonce: session.serverNonce,
        ttlMs: MANAGED_PAIRING_TTL_MS,
        expiresAt: session.expiresAt
      }))
      socket.on('message', (message) => {
        try {
          this.onManagedMessage(session, message)
        } catch (error) {
          this.revokePending(session, error instanceof Error ? error.message : String(error))
          socket.close(1011, 'Pairing state transition failed')
        }
      })
      socket.once('close', () => this.onSocketClosed(session))
    })
  }

  confirm(sessionId: string): ManagedPairingSession {
    const session = this.requireSession(sessionId, 'controller')
    if (session.state !== 'requested') throw new Error('当前配对状态不能确认短码')
    session.socket.send(JSON.stringify({
      type: 'pair-confirm',
      sessionId,
      signature: this.options.authorizations.sign(confirmTranscript(session))
    }))
    session.state = 'code_verified'
    return publicSession(session)
  }

  approve(sessionId: string, input: ApproveManagedPairingInput): ManagedPairingSession {
    const session = this.requireSession(sessionId, 'managed')
    if (session.state !== 'awaiting_local_approval') throw new Error('配对尚未完成短码核对')
    if (Date.parse(session.expiresAt) <= this.now().getTime()) return this.expire(session)
    const endpoint = this.options.getEndpoint()
    if (!endpoint || session.socket.readyState !== WebSocket.OPEN) throw new Error('配对连接已断开')
    const created = this.options.authorizations.grant({
      controllerDeviceId: session.peerIdentity.deviceId,
      controllerDisplayName: session.peerIdentity.displayName,
      controllerPublicKey: session.peerIdentity.publicKey,
      capabilities: input.capabilities,
      allowedRoots: input.allowedRoots
    })
    session.createdAuthorizationId = created.authorization.id
    // 凭证送达不等于控制端已安全落盘；ACK 前保持 paused，/managed 必须拒绝。
    const pendingAuthorization = this.options.authorizations.setStatus(created.authorization.id, 'paused')
    session.state = 'awaiting_ack'
    const remaining = Math.max(1, Date.parse(session.expiresAt) - this.now().getTime())
    session.ackTimer = setTimeout(() => {
      this.revokePending(session, '控制端未在期限内确认保存授权')
      session.socket.close(4408, 'Pairing acknowledgement timeout')
    }, Math.min(this.options.ackTimeoutMs ?? PAIRING_ACK_TIMEOUT_MS, remaining))
    session.ackTimer.unref?.()
    session.socket.send(JSON.stringify({
      type: 'pair-approved',
      sessionId: session.id,
      authorization: pendingAuthorization,
      credential: created.credential,
      managedUrl: managedUrl(endpoint),
      certificateFingerprint: endpoint.certificateFingerprint
    }))
    return publicSession(session)
  }

  reject(sessionId: string): ManagedPairingSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('配对会话不存在')
    session.state = 'rejected'
    this.revokePending(session)
    this.clearExpiry(session)
    session.socket.close(4403, 'Pairing rejected')
    return publicSession(session)
  }

  async setConnectionEnabled(id: string, enabled: boolean): Promise<void> {
    await this.options.controllers.setEnabled(id, enabled)
  }

  async removeConnection(id: string): Promise<void> {
    await this.options.controllers.remove(id)
  }

  /** pending credential 只能由有效 ACK 激活，普通授权 IPC 不得越过该门禁。 */
  assertAuthorizationStatusChangeAllowed(id: string): void {
    if (this.isPendingAuthorization(id)) throw new Error('配对授权仍在等待控制端安全确认，暂不能修改状态')
  }

  close(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    for (const session of this.sessions.values()) {
      this.revokePending(session)
      this.clearExpiry(session)
      session.socket.close(1001, 'Application closing')
    }
    this.discovery.close()
    this.sessions.clear()
  }

  private async requestEndpoint(host: string, port: number): Promise<ManagedPairingSession> {
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('配对地址无效')
    const safeHost = host.includes(':') ? `[${host}]` : host
    const socket = new WebSocket(`wss://${safeHost}:${port}/pairing`, { rejectUnauthorized: false })
    const requestId = randomUUID()
    const clientNonce = randomBytes(32).toString('hex')
    const controller = this.options.authorizations.identity()
    return new Promise<ManagedPairingSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error('配对握手超时'))
      }, 8_000)
      timer.unref?.()
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      socket.once('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
      socket.once('close', (code) => fail(new Error(`配对连接已关闭（${code}）`)))
      socket.once('open', () => {
        socket.send(JSON.stringify({
          type: 'pair-request',
          requestId,
          clientNonce,
          controller,
          signature: this.options.authorizations.sign(requestTranscript(requestId, clientNonce, controller))
        }))
      })
      socket.once('message', (raw) => {
        const challenge = parseMessage(raw)
        const managed = safeIdentity(challenge?.managed)
        const actualFingerprint = peerFingerprint(socket)
        const now = this.now().getTime()
        const remoteExpiry = typeof challenge?.expiresAt === 'string' ? Date.parse(challenge.expiresAt) : Number.NaN
        if (
          challenge?.type !== 'pair-challenge' || !managed ||
          typeof challenge.sessionId !== 'string' ||
          typeof challenge.shortCode !== 'string' || !/^\d{6}$/.test(challenge.shortCode) ||
          typeof challenge.serverNonce !== 'string' || !/^[a-f0-9]{64}$/i.test(challenge.serverNonce) ||
          typeof challenge.certificateFingerprint !== 'string' ||
          !actualFingerprint || actualFingerprint.toUpperCase() !== challenge.certificateFingerprint.toUpperCase() ||
          challenge.ttlMs !== MANAGED_PAIRING_TTL_MS ||
          !Number.isFinite(remoteExpiry) ||
          remoteExpiry <= now - MAX_PAIRING_CLOCK_SKEW_MS ||
          remoteExpiry > now + MANAGED_PAIRING_TTL_MS + MAX_PAIRING_CLOCK_SKEW_MS
        ) {
          socket.terminate()
          fail(new Error('受托管端配对挑战无效或 TLS 指纹不匹配'))
          return
        }
        clearTimeout(timer)
        const session: InternalSession = {
          id: challenge.sessionId,
          role: 'controller',
          state: 'requested',
          peerDeviceId: managed.deviceId,
          peerDisplayName: managed.displayName,
          peerPublicKeyFingerprint: managed.publicKeyFingerprint,
          certificateFingerprint: challenge.certificateFingerprint,
          shortCode: challenge.shortCode,
          // 不信任对端给出的绝对期限；本机从固定协议 TTL 重新计时。
          expiresAt: new Date(now + MANAGED_PAIRING_TTL_MS).toISOString(),
          socket,
          requestId,
          clientNonce,
          serverNonce: challenge.serverNonce,
          peerIdentity: managed
        }
        this.sessions.set(session.id, session)
        this.armExpiry(session)
        socket.on('message', (message) => {
          try {
            this.onControllerMessage(session, message)
          } catch (error) {
            session.state = 'failed'
            session.error = error instanceof Error ? error.message : String(error)
            socket.close(1011, 'Pairing state transition failed')
          }
        })
        socket.once('close', () => this.onSocketClosed(session))
        resolve(publicSession(session))
      })
    })
  }

  private onManagedMessage(session: InternalSession, raw: unknown): void {
    const message = parseMessage(raw)
    if (message?.type === 'pair-confirm' && message.sessionId === session.id && session.state === 'requested') {
      if (Date.parse(session.expiresAt) <= this.now().getTime()) {
        this.expire(session)
        return
      }
      if (
        typeof message.signature !== 'string' ||
        !verifyDeviceSignature(session.peerIdentity.publicKey, confirmTranscript(session), message.signature)
      ) {
        session.state = 'failed'
        session.error = '控制端短码确认签名无效'
        session.socket.close(4401, 'Invalid confirmation signature')
        return
      }
      session.state = 'awaiting_local_approval'
      session.socket.send(JSON.stringify({ type: 'pair-confirmed', sessionId: session.id }))
      return
    }
    if (message?.type === 'pair-ack' && message.sessionId === session.id && session.createdAuthorizationId) {
      if (Date.parse(session.expiresAt) <= this.now().getTime()) {
        this.expire(session)
        return
      }
      if (session.ackTimer) clearTimeout(session.ackTimer)
      session.ackTimer = undefined
      this.options.authorizations.setStatus(session.createdAuthorizationId, 'active')
      session.state = 'active'
      session.createdAuthorizationId = undefined
      this.clearExpiry(session)
      session.socket.close(1000, 'Pairing complete')
      return
    }
    if (message?.type === 'pair-failed' && message.sessionId === session.id) {
      this.revokePending(session, '控制端未能保存授权')
      session.socket.close(1011, 'Controller failed to persist pairing')
    }
  }

  private onControllerMessage(session: InternalSession, raw: unknown): void {
    const message = parseMessage(raw)
    if (message?.type === 'pair-confirmed' && message.sessionId === session.id && session.state === 'code_verified') {
      session.state = 'awaiting_local_approval'
      return
    }
    if (message?.type !== 'pair-approved') return
    if (
      message.sessionId !== session.id ||
      session.state !== 'awaiting_local_approval' ||
      message.authorization === undefined
    ) {
      session.state = 'failed'
      session.error = '受托管端在短码确认完成前返回了乱序授权'
      session.socket.close(4400, 'Out-of-order pairing approval')
      return
    }
    const authorization = message.authorization as Record<string, unknown>
    try {
      if (Date.parse(session.expiresAt) <= this.now().getTime()) {
        this.expire(session)
        return
      }
      if (
        authorization.controllerDeviceId !== this.options.authorizations.identity().deviceId ||
        authorization.managedDeviceId !== session.peerIdentity.deviceId ||
        typeof authorization.id !== 'string' || typeof message.credential !== 'string' ||
        typeof message.managedUrl !== 'string' ||
        message.certificateFingerprint !== session.certificateFingerprint ||
        !Array.isArray(authorization.capabilities) || !Array.isArray(authorization.allowedRoots)
      ) throw new Error('受托管端返回的授权与当前配对不一致')
      this.options.controllers.add({
        authorizationId: authorization.id,
        controllerDeviceId: authorization.controllerDeviceId,
        managedDeviceId: authorization.managedDeviceId,
        managedDisplayName: session.peerDisplayName,
        url: message.managedUrl,
        certificateFingerprint: session.certificateFingerprint,
        credential: message.credential,
        capabilities: authorization.capabilities,
        allowedRoots: authorization.allowedRoots
      })
      session.state = 'active'
      session.socket.send(JSON.stringify({ type: 'pair-ack', sessionId: session.id }))
    } catch (error) {
      session.state = 'failed'
      session.error = error instanceof Error ? error.message : String(error)
      session.socket.send(JSON.stringify({ type: 'pair-failed', sessionId: session.id }))
      session.socket.close(1011, 'Failed to persist pairing')
    }
  }

  private onSocketClosed(session: InternalSession): void {
    if (session.state !== 'active') this.revokePending(session)
    if (!['active', 'rejected', 'expired', 'failed'].includes(session.state)) {
      session.state = 'failed'
      session.error = '配对连接已断开，请重新发起'
    }
    this.clearExpiry(session)
  }

  private requireSession(id: string, role: InternalSession['role']): InternalSession {
    this.sweep()
    const session = this.sessions.get(id)
    if (!session || session.role !== role) throw new Error('配对会话不存在')
    return session
  }

  private isPendingAuthorization(id: string): boolean {
    return [...this.sessions.values()].some((session) => session.createdAuthorizationId === id)
  }

  private expire(session: InternalSession): ManagedPairingSession {
    this.revokePending(session)
    this.clearExpiry(session)
    session.state = 'expired'
    session.socket.close(4408, 'Pairing expired')
    return publicSession(session)
  }

  private armExpiry(session: InternalSession): void {
    this.clearExpiry(session)
    const remaining = Math.max(1, Date.parse(session.expiresAt) - this.now().getTime())
    session.expiryTimer = setTimeout(() => this.expire(session), remaining)
    session.expiryTimer.unref?.()
  }

  private clearExpiry(session: InternalSession): void {
    if (session.expiryTimer) clearTimeout(session.expiryTimer)
    session.expiryTimer = undefined
  }

  private revokePending(session: InternalSession, error?: string): void {
    if (session.ackTimer) clearTimeout(session.ackTimer)
    session.ackTimer = undefined
    if (session.createdAuthorizationId) {
      this.options.authorizations.setStatus(session.createdAuthorizationId, 'revoked')
      session.createdAuthorizationId = undefined
    }
    if (error) {
      session.state = 'failed'
      session.error = error
    }
  }

  private sweep(): void {
    const now = this.now().getTime()
    for (const [id, session] of this.sessions) {
      if (['active', 'rejected', 'failed', 'expired'].includes(session.state) && Date.parse(session.expiresAt) + 60_000 <= now) {
        this.sessions.delete(id)
        continue
      }
      if (!['active', 'rejected', 'failed', 'expired'].includes(session.state) && Date.parse(session.expiresAt) <= now) {
        this.expire(session)
      }
    }
    for (const [id, device] of this.nearby) {
      if (Date.parse(device.lastSeenAt) + 180_000 < now) this.nearby.delete(id)
    }
  }

  private allowAttempt(remoteAddress: string): boolean {
    const now = this.now().getTime()
    for (const [address, attempts] of this.attempts) {
      if (attempts.every((at) => at + ATTEMPT_WINDOW_MS <= now)) this.attempts.delete(address)
    }
    const recent = (this.attempts.get(remoteAddress) ?? []).filter((at) => at + ATTEMPT_WINDOW_MS > now)
    if (recent.length >= MAX_PAIRING_ATTEMPTS) return false
    recent.push(now)
    this.attempts.set(remoteAddress, recent)
    return true
  }

  private publish(): void {
    const endpoint = this.options.getEndpoint()
    if (!endpoint) {
      this.discovery.stopAdvertising()
      return
    }
    this.discovery.advertise({
      discoveryId: this.discoveryId(),
      displayName: this.options.authorizations.identity().displayName,
      platform: this.options.platform ?? process.platform,
      host: endpoint.host,
      port: endpoint.port,
      protocolVersion: MANAGED_PAIRING_PROTOCOL_VERSION,
      lastSeenAt: this.now().toISOString()
    })
  }

  private discoveryId(): string {
    const bucket = Math.floor(this.now().getTime() / MANAGED_PAIRING_TTL_MS)
    return createHash('sha256')
      .update(`${this.startupSalt}:${this.options.authorizations.identity().deviceId}:${bucket}`)
      .digest('hex')
      .slice(0, 16)
  }
}
