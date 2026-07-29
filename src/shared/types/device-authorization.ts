// SPEC-032 v2：GUI 设备身份与方向性受托管授权的共享公开模型。

export const MANAGED_DEVICE_CAPABILITIES = [
  'runtime:status',
  'runtime:list-agents',
  'directory:list',
  'session:create',
  'session:read',
  'session:write',
  'session:terminate'
] as const

export type ManagedDeviceCapability = typeof MANAGED_DEVICE_CAPABILITIES[number]
export type ManagedDeviceAuthorizationStatus = 'active' | 'paused' | 'revoked'

/** 可安全展示给渲染端的本机设备身份；私钥只存在于主进程持久化记录。 */
export interface ManagedDeviceIdentity {
  schemaVersion: 1
  deviceId: string
  displayName: string
  publicKey: string
  publicKeyFingerprint: string
  createdAt: string
}

/** 主进程持久化的完整设备身份。禁止经 IPC 返回。 */
export interface ManagedDeviceIdentityRecord extends ManagedDeviceIdentity {
  privateKey: string
}

/** 受托管端持久化的单向授权公开视图。 */
export interface ManagedDeviceAuthorization {
  schemaVersion: 1
  id: string
  controllerDeviceId: string
  managedDeviceId: string
  controllerDisplayName: string
  controllerPublicKey: string
  controllerPublicKeyFingerprint: string
  capabilities: ManagedDeviceCapability[]
  allowedRoots: string[]
  status: ManagedDeviceAuthorizationStatus
  createdAt: string
  updatedAt: string
  lastConnectedAt?: string
}

/** 受托管端内部记录；只保存随机长期凭证的 SHA-256，不保存明文。 */
export interface ManagedDeviceAuthorizationRecord extends ManagedDeviceAuthorization {
  credentialHash: string
}

export interface CreateManagedDeviceAuthorizationInput {
  controllerDeviceId: string
  controllerDisplayName: string
  controllerPublicKey: string
  capabilities: ManagedDeviceCapability[]
  allowedRoots: string[]
}

/** 新授权只在创建时返回一次长期凭证明文，后续列表永不返回。 */
export interface CreatedManagedDeviceAuthorization {
  authorization: ManagedDeviceAuthorization
  credential: string
}

export interface ManagedDeviceCredentialCheck {
  authorizationId: string
  controllerDeviceId: string
  credential: string
}

export interface ManagedDeviceAuthorizationCheck extends ManagedDeviceCredentialCheck {
  capability: ManagedDeviceCapability
  /** 带目录/会话 cwd 的操作必须传入；无授权根时默认拒绝。 */
  workspacePath?: string
}

export type ManagedDeviceAuthorizationDecision =
  | { allowed: true; authorization: ManagedDeviceAuthorization }
  | { allowed: false; reason: string }

/** GUI 受托管 Runtime 中由某条授权创建的资源所有权；跨重启保持隔离。 */
export interface ManagedSessionOwnership {
  authorizationId: string
  sessionId: string
  terminalSessionId?: string
  createdAt: string
  updatedAt: string
}

export type ManagedDeviceConnectionState = 'connecting' | 'connected' | 'disconnected' | 'disabled'

/** 控制端保存的出站方向性授权；credential 只能存在于主进程 0600 配置文件。 */
export interface ManagedDeviceConnectionRecord {
  schemaVersion: 1
  id: string
  authorizationId: string
  controllerDeviceId: string
  managedDeviceId: string
  managedDisplayName: string
  url: string
  certificateFingerprint: string
  credential: string
  capabilities: ManagedDeviceCapability[]
  allowedRoots: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastConnectedAt?: string
}

/** 可安全展示给 GUI 的出站连接，不含长期凭证。 */
export interface ManagedDeviceConnection extends Omit<ManagedDeviceConnectionRecord, 'credential'> {
  connection: ManagedDeviceConnectionState
  error?: string
}

export interface CreateManagedDeviceConnectionInput {
  authorizationId: string
  controllerDeviceId: string
  managedDeviceId: string
  managedDisplayName: string
  url: string
  certificateFingerprint: string
  credential: string
  capabilities: ManagedDeviceCapability[]
  allowedRoots: string[]
}
