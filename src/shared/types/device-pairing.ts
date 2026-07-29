import type {
  ManagedDeviceAuthorization,
  ManagedDeviceCapability,
  ManagedDeviceConnection,
  ManagedDeviceIdentity
} from './device-authorization'

export const MANAGED_PAIRING_PROTOCOL_VERSION = 1
export const MANAGED_PAIRING_TTL_MS = 5 * 60_000

export type ManagedPairingState =
  | 'requested'
  | 'code_verified'
  | 'awaiting_local_approval'
  | 'awaiting_ack'
  | 'active'
  | 'rejected'
  | 'expired'
  | 'failed'

/** mDNS 只公开临时摘要和连接信息；稳定 deviceId、公钥与能力均不广播。 */
export interface NearbyManagedDevice {
  discoveryId: string
  displayName: string
  platform: string
  host: string
  port: number
  protocolVersion: number
  lastSeenAt: string
}

/** 配对会话的渲染端公开视图；不包含 nonce、签名、私钥或长期凭证。 */
export interface ManagedPairingSession {
  id: string
  role: 'controller' | 'managed'
  state: ManagedPairingState
  peerDeviceId: string
  peerDisplayName: string
  peerPublicKeyFingerprint: string
  certificateFingerprint: string
  shortCode: string
  expiresAt: string
  error?: string
}

export interface ManagedPairingSnapshot {
  discoverable: boolean
  /** 可复制到另一台 GUI 的手工回退地址；不含凭证。 */
  manualEndpoint?: string
  identity: ManagedDeviceIdentity
  nearbyDevices: NearbyManagedDevice[]
  sessions: ManagedPairingSession[]
  inboundAuthorizations: ManagedDeviceAuthorization[]
  outboundConnections: ManagedDeviceConnection[]
}

export interface ApproveManagedPairingInput {
  capabilities: ManagedDeviceCapability[]
  allowedRoots: string[]
}
