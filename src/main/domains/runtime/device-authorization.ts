// SPEC-032 v2：GUI 设备身份与方向性授权真源。
// 受托管端保存控制端公钥、最小 capability、授权目录和长期凭证摘要；明文凭证只返回一次。

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signPayload,
  timingSafeEqual,
  verify as verifyPayload
} from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { parse, relative, resolve } from 'node:path'
import type {
  CreatedManagedDeviceAuthorization,
  CreateManagedDeviceAuthorizationInput,
  ManagedDeviceAuthorization,
  ManagedDeviceAuthorizationCheck,
  ManagedDeviceAuthorizationDecision,
  ManagedDeviceCredentialCheck,
  ManagedDeviceAuthorizationRecord,
  ManagedDeviceAuthorizationStatus,
  ManagedDeviceCapability,
  ManagedDeviceIdentity,
  ManagedDeviceIdentityRecord
} from '@shared/types'
import { MANAGED_DEVICE_CAPABILITIES } from '@shared/types'

export interface DeviceAuthorizationStore {
  getIdentity(): ManagedDeviceIdentityRecord | null
  setIdentity(identity: ManagedDeviceIdentityRecord): void
  getAuthorizations(): ManagedDeviceAuthorizationRecord[]
  setAuthorizations(authorizations: ManagedDeviceAuthorizationRecord[]): void
}

export interface DeviceAuthorizationRegistryOptions {
  displayName: string
  now?: () => Date
  canonicalizePath?: (path: string) => string
}

const capabilitySet = new Set<string>(MANAGED_DEVICE_CAPABILITIES)
const pathBoundCapabilities = new Set<ManagedDeviceCapability>(['directory:list', 'session:create'])
const authorizationStatuses = new Set<ManagedDeviceAuthorizationStatus>(['active', 'paused', 'revoked'])

function publicIdentity(record: ManagedDeviceIdentityRecord): ManagedDeviceIdentity {
  return {
    schemaVersion: record.schemaVersion,
    deviceId: record.deviceId,
    displayName: record.displayName,
    publicKey: record.publicKey,
    publicKeyFingerprint: record.publicKeyFingerprint,
    createdAt: record.createdAt
  }
}

function publicAuthorization(record: ManagedDeviceAuthorizationRecord): ManagedDeviceAuthorization {
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    controllerDeviceId: record.controllerDeviceId,
    managedDeviceId: record.managedDeviceId,
    controllerDisplayName: record.controllerDisplayName,
    controllerPublicKey: record.controllerPublicKey,
    controllerPublicKeyFingerprint: record.controllerPublicKeyFingerprint,
    capabilities: [...record.capabilities],
    allowedRoots: [...record.allowedRoots],
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastConnectedAt ? { lastConnectedAt: record.lastConnectedAt } : {})
  }
}

function publicKeyDer(publicKey: string): Buffer {
  const key = createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('设备公钥必须使用 Ed25519')
  return key.export({ format: 'der', type: 'spki' }) as Buffer
}

export function devicePublicKeyFingerprint(publicKey: string): string {
  return createHash('sha256')
    .update(publicKeyDer(publicKey))
    .digest('hex')
    .toUpperCase()
    .match(/../g)!
    .join(':')
}

/** 配对握手使用稳定设备密钥签名；私钥不会离开主进程。 */
export function verifyDeviceSignature(publicKey: string, payload: string, signature: string): boolean {
  try {
    publicKeyDer(publicKey)
    return verifyPayload(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

function credentialHash(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest()
}

function isSafeDeviceId(value: string): boolean {
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(value)
}

function pathInside(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !parse(pathFromRoot).root)
}

export class DeviceAuthorizationRegistry {
  private readonly now: () => Date
  private readonly canonicalizePath: (path: string) => string

  constructor(
    private readonly store: DeviceAuthorizationStore,
    private readonly options: DeviceAuthorizationRegistryOptions
  ) {
    this.now = options.now ?? (() => new Date())
    this.canonicalizePath = options.canonicalizePath ?? ((path) => realpathSync.native(resolve(path)))
  }

  identity(): ManagedDeviceIdentity {
    const stored = this.store.getIdentity()
    if (stored) {
      this.validateIdentity(stored)
      return publicIdentity(stored)
    }

    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }
    })
    const createdAt = this.now().toISOString()
    const identity: ManagedDeviceIdentityRecord = {
      schemaVersion: 1,
      deviceId: randomUUID(),
      displayName: this.options.displayName.trim() || 'Agent OS',
      publicKey,
      privateKey,
      publicKeyFingerprint: devicePublicKeyFingerprint(publicKey),
      createdAt
    }
    this.store.setIdentity(identity)
    return publicIdentity(identity)
  }

  sign(payload: string): string {
    const identity = this.store.getIdentity()
    if (!identity) {
      this.identity()
      return this.sign(payload)
    }
    this.validateIdentity(identity)
    return signPayload(null, Buffer.from(payload, 'utf8'), identity.privateKey).toString('base64')
  }

  list(): ManagedDeviceAuthorization[] {
    return this.store.getAuthorizations().map(publicAuthorization)
  }

  grant(input: CreateManagedDeviceAuthorizationInput): CreatedManagedDeviceAuthorization {
    const identity = this.identity()
    if (!isSafeDeviceId(input.controllerDeviceId)) throw new Error('控制端 deviceId 无效')
    if (input.controllerDeviceId === identity.deviceId) throw new Error('不能授权本机控制本机')
    const controllerDisplayName = input.controllerDisplayName.trim()
    if (!controllerDisplayName || controllerDisplayName.length > 120) throw new Error('控制端名称无效')
    const controllerPublicKeyFingerprint = devicePublicKeyFingerprint(input.controllerPublicKey)
    const capabilities = [...new Set(input.capabilities)]
    if (capabilities.some((capability) => !capabilitySet.has(capability))) {
      throw new Error('包含未知的受托管 capability')
    }
    const allowedRoots = [...new Set(input.allowedRoots.map((root) => this.canonicalRoot(root)))]
    const existing = this.store.getAuthorizations()
    if (existing.some((authorization) =>
      authorization.controllerDeviceId === input.controllerDeviceId && authorization.status !== 'revoked'
    )) {
      throw new Error('该控制端已有未撤销的方向性授权')
    }

    const now = this.now().toISOString()
    const credential = randomBytes(32).toString('hex')
    const record: ManagedDeviceAuthorizationRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      controllerDeviceId: input.controllerDeviceId,
      managedDeviceId: identity.deviceId,
      controllerDisplayName,
      controllerPublicKey: input.controllerPublicKey,
      controllerPublicKeyFingerprint,
      capabilities,
      allowedRoots,
      status: 'active',
      credentialHash: credentialHash(credential).toString('hex'),
      createdAt: now,
      updatedAt: now
    }
    this.store.setAuthorizations([...existing, record])
    return { authorization: publicAuthorization(record), credential }
  }

  setStatus(id: string, status: ManagedDeviceAuthorizationStatus): ManagedDeviceAuthorization {
    if (!authorizationStatuses.has(status)) throw new Error('未知的方向性授权状态')
    let updated: ManagedDeviceAuthorizationRecord | undefined
    const authorizations = this.store.getAuthorizations().map((authorization) => {
      if (authorization.id !== id) return authorization
      if (authorization.status === 'revoked' && status !== 'revoked') {
        throw new Error('已撤销授权不能重新启用，请重新配对')
      }
      updated = { ...authorization, status, updatedAt: this.now().toISOString() }
      return updated
    })
    if (!updated) throw new Error('方向性授权不存在')
    this.store.setAuthorizations(authorizations)
    return publicAuthorization(updated)
  }

  markConnected(id: string): ManagedDeviceAuthorization {
    let updated: ManagedDeviceAuthorizationRecord | undefined
    const now = this.now().toISOString()
    const authorizations = this.store.getAuthorizations().map((authorization) => {
      if (authorization.id !== id) return authorization
      if (authorization.status !== 'active') throw new Error('非 active 授权不能建立连接')
      updated = { ...authorization, lastConnectedAt: now, updatedAt: now }
      return updated
    })
    if (!updated) throw new Error('方向性授权不存在')
    this.store.setAuthorizations(authorizations)
    return publicAuthorization(updated)
  }

  authenticate(check: ManagedDeviceCredentialCheck): ManagedDeviceAuthorizationDecision {
    const record = this.store.getAuthorizations().find((authorization) => authorization.id === check.authorizationId)
    if (!record) return { allowed: false, reason: '方向性授权不存在' }
    if (record.managedDeviceId !== this.identity().deviceId) return { allowed: false, reason: '授权不属于本机' }
    if (record.controllerDeviceId !== check.controllerDeviceId) return { allowed: false, reason: '控制端身份不匹配' }
    if (record.status !== 'active') return { allowed: false, reason: `授权状态为 ${record.status}` }
    if (!/^[a-f0-9]{64}$/i.test(check.credential)) return { allowed: false, reason: '授权凭证无效' }
    const actualHash = credentialHash(check.credential)
    const expectedHash = Buffer.from(record.credentialHash, 'hex')
    if (expectedHash.length !== actualHash.length || !timingSafeEqual(actualHash, expectedHash)) {
      return { allowed: false, reason: '授权凭证无效' }
    }
    return { allowed: true, authorization: publicAuthorization(record) }
  }

  authorize(check: ManagedDeviceAuthorizationCheck): ManagedDeviceAuthorizationDecision {
    const authenticated = this.authenticate(check)
    if (!authenticated.allowed) return authenticated
    const record = this.store.getAuthorizations().find((authorization) => authorization.id === check.authorizationId)!
    if (!record.capabilities.includes(check.capability)) return { allowed: false, reason: 'capability 未授权' }

    if (pathBoundCapabilities.has(check.capability) || check.workspacePath !== undefined) {
      if (!check.workspacePath || record.allowedRoots.length === 0) {
        return { allowed: false, reason: '该操作需要明确授权目录' }
      }
      let candidate: string
      try {
        candidate = this.canonicalizePath(check.workspacePath)
      } catch {
        return { allowed: false, reason: '目标目录不存在或不可访问' }
      }
      if (!record.allowedRoots.some((root) => pathInside(candidate, root))) {
        return { allowed: false, reason: '目标目录超出授权范围' }
      }
    }
    return { allowed: true, authorization: publicAuthorization(record) }
  }

  private canonicalRoot(path: string): string {
    if (!path || path.includes('\0')) throw new Error('授权目录无效')
    const canonical = this.canonicalizePath(path)
    if (!statSync(canonical).isDirectory()) throw new Error('授权根必须是目录')
    if (canonical === parse(canonical).root) throw new Error('不能把文件系统根目录授权给远程控制端')
    return canonical
  }

  private validateIdentity(identity: ManagedDeviceIdentityRecord): void {
    if (identity.schemaVersion !== 1 || !isSafeDeviceId(identity.deviceId)) throw new Error('本机设备身份损坏')
    const privateKey = createPrivateKey(identity.privateKey)
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('本机设备私钥损坏')
    const derivedPublicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString()
    if (publicKeyDer(derivedPublicKey).compare(publicKeyDer(identity.publicKey)) !== 0) {
      throw new Error('本机设备公私钥不匹配')
    }
    if (devicePublicKeyFingerprint(identity.publicKey) !== identity.publicKeyFingerprint) {
      throw new Error('本机设备公钥指纹不匹配')
    }
  }
}
