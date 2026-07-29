import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fakeStore = vi.hoisted(() => ({
  path: '',
  data: {} as Record<string, unknown>,
  persist: null as null | (() => void),
  configFileMode: 0o666
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.2.9' }
}))

vi.mock('electron-store', () => ({
  default: class FakeElectronStore {
    path = fakeStore.path

    constructor(options: { defaults: Record<string, unknown>; configFileMode?: number }) {
      fakeStore.data = structuredClone(options.defaults)
      fakeStore.configFileMode = options.configFileMode ?? 0o666
    }

    get(key: string): unknown {
      return key.split('.').reduce<unknown>((value, part) => (
        value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
      ), fakeStore.data)
    }

    set(key: string, value: unknown): void {
      const parts = key.split('.')
      let target = fakeStore.data
      for (const part of parts.slice(0, -1)) {
        const nested = target[part]
        if (!nested || typeof nested !== 'object') target[part] = {}
        target = target[part] as Record<string, unknown>
      }
      target[parts.at(-1)!] = value
      fakeStore.persist?.()
    }
  }
}))

let directory = ''

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
  fakeStore.persist = null
  fakeStore.configFileMode = 0o666
  vi.resetModules()
})

describe('AppStore credential file permissions', () => {
  it('加载已有的宽松权限配置时立即迁移为 0600', async () => {
    directory = mkdtempSync(join(tmpdir(), 'agent-os-store-security-'))
    fakeStore.path = join(directory, 'agent-os.json')
    writeFileSync(fakeStore.path, '{"existing":true}', { mode: 0o644 })
    chmodSync(fakeStore.path, 0o644)

    await import('../src/main/store/app-store')

    expect(statSync(fakeStore.path).mode & 0o777).toBe(0o600)
  })

  it('写入渠道账号凭据后把 electron-store 文件收紧为 0600', async () => {
    directory = mkdtempSync(join(tmpdir(), 'agent-os-store-security-'))
    fakeStore.path = join(directory, 'agent-os.json')
    fakeStore.persist = () => {
      writeFileSync(fakeStore.path, JSON.stringify(fakeStore.data), { mode: 0o644 })
      chmodSync(fakeStore.path, 0o644)
    }

    const { setChannelAccounts } = await import('../src/main/store/app-store')
    setChannelAccounts([{
      id: 'telegram-primary',
      platform: 'telegram',
      alias: 'Telegram',
      enabled: true,
      credentials: { bot_token: 'test-secret-token' }
    }])

    expect(statSync(fakeStore.path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(fakeStore.path, 'utf8')).channelAccounts[0].credentials)
      .toEqual({ bot_token: 'test-secret-token' })
  })

  it('写入 GUI 设备私钥和方向性授权摘要后把存储文件收紧为 0600', async () => {
    directory = mkdtempSync(join(tmpdir(), 'agent-os-store-security-'))
    fakeStore.path = join(directory, 'agent-os.json')
    fakeStore.persist = () => {
      writeFileSync(fakeStore.path, JSON.stringify(fakeStore.data), { mode: 0o644 })
      chmodSync(fakeStore.path, 0o644)
    }

    const {
      setManagedDeviceIdentity,
      setManagedDeviceAuthorizations,
      setManagedDeviceConnections,
      getManagedDeviceConnections
    } = await import('../src/main/store/app-store')
    setManagedDeviceIdentity({
      schemaVersion: 1,
      deviceId: 'local-device-0001',
      displayName: 'Local Mac',
      publicKey: 'public-key',
      privateKey: 'private-key',
      publicKeyFingerprint: 'AA:BB',
      createdAt: '2026-07-19T08:00:00.000Z'
    })
    setManagedDeviceAuthorizations([{
      schemaVersion: 1,
      id: 'authorization-0001',
      controllerDeviceId: 'controller-device-0001',
      managedDeviceId: 'local-device-0001',
      controllerDisplayName: 'Controller',
      controllerPublicKey: 'controller-public-key',
      controllerPublicKeyFingerprint: 'CC:DD',
      capabilities: ['runtime:status'],
      allowedRoots: [],
      status: 'active',
      credentialHash: 'a'.repeat(64),
      createdAt: '2026-07-19T08:00:00.000Z',
      updatedAt: '2026-07-19T08:00:00.000Z'
    }])
    setManagedDeviceConnections([{
      schemaVersion: 1,
      id: 'connection-0001',
      authorizationId: 'remote-authorization-0001',
      controllerDeviceId: 'local-device-0001',
      managedDeviceId: 'remote-device-0001',
      managedDisplayName: 'Remote Mac',
      url: 'wss://192.168.1.20:7431/managed',
      certificateFingerprint: 'AA:'.repeat(31) + 'AA',
      credential: 'b'.repeat(64),
      capabilities: ['runtime:status'],
      allowedRoots: [],
      enabled: true,
      createdAt: '2026-07-19T08:00:00.000Z',
      updatedAt: '2026-07-19T08:00:00.000Z'
    }])

    expect(statSync(fakeStore.path).mode & 0o777).toBe(0o600)
    const persisted = JSON.parse(readFileSync(fakeStore.path, 'utf8'))
    expect(persisted.managedDeviceIdentity.privateKey).toBe('private-key')
    expect(persisted.managedDeviceAuthorizations[0].credentialHash).toBe('a'.repeat(64))
    expect(persisted.managedDeviceConnections[0].credential).toBe('b'.repeat(64))

    // 手工损坏单条字段时 getter 只能防御性克隆，不能在 registry 严格校验前把应用启动打崩。
    const corruptedConnections = fakeStore.data.managedDeviceConnections as Array<Record<string, unknown>>
    corruptedConnections[0].capabilities = null
    expect(() => getManagedDeviceConnections()).not.toThrow()
  })

  it('敏感数据写入后再修改普通设置，原子重写仍保持 0600', async () => {
    directory = mkdtempSync(join(tmpdir(), 'agent-os-store-security-'))
    fakeStore.path = join(directory, 'agent-os.json')
    fakeStore.persist = () => {
      writeFileSync(fakeStore.path, JSON.stringify(fakeStore.data), { mode: fakeStore.configFileMode })
      chmodSync(fakeStore.path, fakeStore.configFileMode)
    }

    const {
      setManagedDeviceIdentity,
      setLanguage
    } = await import('../src/main/store/app-store')
    setManagedDeviceIdentity({
      schemaVersion: 1,
      deviceId: 'local-device-0001',
      displayName: 'Local Mac',
      publicKey: 'public-key',
      privateKey: 'private-key',
      publicKeyFingerprint: 'AA:BB',
      createdAt: '2026-07-19T08:00:00.000Z'
    })
    expect(statSync(fakeStore.path).mode & 0o777).toBe(0o600)

    setLanguage('en')

    expect(fakeStore.configFileMode).toBe(0o600)
    expect(statSync(fakeStore.path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(fakeStore.path, 'utf8')).managedDeviceIdentity.privateKey)
      .toBe('private-key')
  })
})
