import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ManagedDeviceAuthorizationRecord,
  ManagedDeviceIdentityRecord
} from '../src/shared/types'
import {
  DeviceAuthorizationRegistry,
  type DeviceAuthorizationStore
} from '../src/main/domains/runtime/device-authorization'

class MemoryStore implements DeviceAuthorizationStore {
  identity: ManagedDeviceIdentityRecord | null = null
  authorizations: ManagedDeviceAuthorizationRecord[] = []

  getIdentity(): ManagedDeviceIdentityRecord | null {
    return this.identity ? structuredClone(this.identity) : null
  }
  setIdentity(identity: ManagedDeviceIdentityRecord): void {
    this.identity = structuredClone(identity)
  }
  getAuthorizations(): ManagedDeviceAuthorizationRecord[] {
    return structuredClone(this.authorizations)
  }
  setAuthorizations(authorizations: ManagedDeviceAuthorizationRecord[]): void {
    this.authorizations = structuredClone(authorizations)
  }
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(): { store: MemoryStore; registry: DeviceAuthorizationRegistry } {
  const store = new MemoryStore()
  return {
    store,
    registry: new DeviceAuthorizationRegistry(store, {
      displayName: '书房 Mac',
      now: () => new Date('2026-07-19T08:00:00.000Z')
    })
  }
}

function controllerPublicKey(): string {
  const other = fixture()
  return other.registry.identity().publicKey
}

describe('SPEC-032 v2 GUI 设备身份与方向性授权', () => {
  it('首次生成稳定 Ed25519 身份，公开视图不泄露私钥', () => {
    const { store, registry } = fixture()
    const first = registry.identity()
    const second = registry.identity()

    expect(second).toEqual(first)
    expect(first.deviceId).toMatch(/^[a-f0-9-]{36}$/)
    expect(first.publicKey).toContain('BEGIN PUBLIC KEY')
    expect(first.publicKeyFingerprint).toMatch(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/)
    expect(first).not.toHaveProperty('privateKey')
    expect(store.identity?.privateKey).toContain('BEGIN PRIVATE KEY')
  })

  it('授权只保存长期凭证摘要，公开列表不返回摘要或明文', () => {
    const { store, registry } = fixture()
    const granted = registry.grant({
      controllerDeviceId: 'controller-device-0001',
      controllerDisplayName: '办公室 Mac',
      controllerPublicKey: controllerPublicKey(),
      capabilities: ['runtime:status', 'runtime:list-agents'],
      allowedRoots: []
    })

    expect(granted.credential).toMatch(/^[a-f0-9]{64}$/)
    expect(granted.authorization).not.toHaveProperty('credentialHash')
    expect(store.authorizations[0].credentialHash).toBe(
      createHash('sha256').update(granted.credential).digest('hex')
    )
    expect(JSON.stringify(registry.list())).not.toContain(granted.credential)
    expect(registry.list()[0]).not.toHaveProperty('credentialHash')
  })

  it('凭证、控制端、capability 和状态任一不符都 fail closed', () => {
    const { registry } = fixture()
    const granted = registry.grant({
      controllerDeviceId: 'controller-device-0001',
      controllerDisplayName: '办公室 Mac',
      controllerPublicKey: controllerPublicKey(),
      capabilities: ['runtime:status'],
      allowedRoots: []
    })
    const base = {
      authorizationId: granted.authorization.id,
      controllerDeviceId: 'controller-device-0001',
      credential: granted.credential,
      capability: 'runtime:status' as const
    }

    expect(registry.authenticate({
      authorizationId: base.authorizationId,
      controllerDeviceId: base.controllerDeviceId,
      credential: base.credential
    }).allowed).toBe(true)
    expect(registry.authorize(base).allowed).toBe(true)
    expect(registry.authenticate({ ...base, credential: '0'.repeat(64) }).allowed).toBe(false)
    expect(registry.authorize({ ...base, credential: '0'.repeat(64) }).allowed).toBe(false)
    expect(registry.authorize({ ...base, controllerDeviceId: 'other-controller' }).allowed).toBe(false)
    expect(registry.authorize({ ...base, capability: 'session:create' }).allowed).toBe(false)
    registry.setStatus(granted.authorization.id, 'paused')
    expect(registry.authorize(base)).toEqual({ allowed: false, reason: '授权状态为 paused' })
    registry.setStatus(granted.authorization.id, 'revoked')
    expect(() => registry.setStatus(granted.authorization.id, 'active')).toThrow('重新配对')
  })

  it('目录能力使用 realpath 边界，拒绝根目录、兄弟目录和根内符号链接逃逸', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-device-auth-'))
    temporaryDirectories.push(root)
    const allowed = join(root, 'allowed')
    const child = join(allowed, 'project')
    const sibling = join(root, 'allowed-escape')
    mkdirSync(child, { recursive: true })
    mkdirSync(sibling)
    symlinkSync(sibling, join(allowed, 'outside-link'))

    const { registry } = fixture()
    expect(() => registry.grant({
      controllerDeviceId: 'controller-device-root',
      controllerDisplayName: 'Root Controller',
      controllerPublicKey: controllerPublicKey(),
      capabilities: ['session:create'],
      allowedRoots: ['/']
    })).toThrow('文件系统根目录')

    const granted = registry.grant({
      controllerDeviceId: 'controller-device-0001',
      controllerDisplayName: '办公室 Mac',
      controllerPublicKey: controllerPublicKey(),
      capabilities: ['session:create', 'directory:list'],
      allowedRoots: [allowed, `${allowed}/.`]
    })
    expect(granted.authorization.allowedRoots).toHaveLength(1)
    const check = {
      authorizationId: granted.authorization.id,
      controllerDeviceId: 'controller-device-0001',
      credential: granted.credential,
      capability: 'session:create' as const
    }
    expect(registry.authorize({ ...check, workspacePath: child }).allowed).toBe(true)
    expect(registry.authorize({ ...check, workspacePath: sibling })).toEqual({
      allowed: false,
      reason: '目标目录超出授权范围'
    })
    expect(registry.authorize({ ...check, workspacePath: join(allowed, 'outside-link') })).toEqual({
      allowed: false,
      reason: '目标目录超出授权范围'
    })
  })

  it('损坏或不匹配的本机密钥不会被静默轮换', () => {
    const { store, registry } = fixture()
    registry.identity()
    store.identity = { ...store.identity!, publicKeyFingerprint: '00:11' }
    expect(() => registry.identity()).toThrow('指纹不匹配')
  })
})
