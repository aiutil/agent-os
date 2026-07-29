// SPEC-032 Step J3：控制端出站授权的持久化真源与联邦 Runtime 生命周期。

import { randomUUID } from 'node:crypto'
import type {
  CreateManagedDeviceConnectionInput,
  ManagedDeviceConnection,
  ManagedDeviceConnectionRecord,
  ManagedDeviceConnectionState,
  RemoteNodeStatus
} from '@shared/types'
import { MANAGED_DEVICE_CAPABILITIES } from '@shared/types'
import type { FederatedRuntimeHost } from './federated-runtime-host'
import { LOCAL_HOST_ID } from './federated-runtime-host'
import {
  startManagedGatewayClient,
  validateManagedGatewayClientOptions,
  type ManagedGatewayClient
} from './managed-gateway-client'

export interface ManagedDeviceConnectionStore {
  get(): ManagedDeviceConnectionRecord[]
  set(connections: ManagedDeviceConnectionRecord[]): void
}

interface ConnectionRuntimeState {
  connection: ManagedDeviceConnectionState
  error?: string
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const capabilitySet = new Set<string>(MANAGED_DEVICE_CAPABILITIES)

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function recordIdentity(
  value: unknown,
  key: keyof ManagedDeviceConnectionRecord
): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

/**
 * 会话选择器只消费一份 RemoteNodeStatus 列表。旧式 enroll 节点与 GUI 手工配对
 * 来自不同仓储；在 IPC 边界合并时，较新的 managed 状态覆盖同 id 的旧快照。
 */
export function mergeRemoteNodeStatuses(
  legacy: RemoteNodeStatus[],
  managed: RemoteNodeStatus[]
): RemoteNodeStatus[] {
  const merged = new Map(legacy.map((status) => [status.id, status]))
  for (const status of managed) merged.set(status.id, status)
  return [...merged.values()]
}

export class ManagedDeviceControllerRegistry {
  private readonly clients = new Map<string, ManagedGatewayClient>()
  private readonly states = new Map<string, ConnectionRuntimeState>()
  /** RemoteRuntimeHost 的最近一次完整状态（含远端 Agent 清单）。 */
  private readonly remoteStatuses = new Map<string, RemoteNodeStatus>()
  private readonly validatedIds = new Set<string>()

  constructor(
    private readonly federation: FederatedRuntimeHost,
    private readonly store: ManagedDeviceConnectionStore,
    private readonly controllerDeviceId: string,
    private readonly onChange?: (connection: ManagedDeviceConnection) => void,
    private readonly onRemoteStatusChange?: (status: RemoteNodeStatus) => void
  ) {}

  init(): void {
    const stored = this.stored()
    const duplicateIds = duplicated(stored.map((item) => recordIdentity(item, 'id')))
    const duplicateAuthorizations = duplicated(
      stored.map((item) => recordIdentity(item, 'authorizationId'))
    )
    const duplicateDevices = duplicated(
      stored.map((item) => recordIdentity(item, 'managedDeviceId'))
    )
    for (const raw of stored) {
      const validated = this.validateRecord(
        raw,
        duplicateIds,
        duplicateAuthorizations,
        duplicateDevices
      )
      if (!validated.ok) {
        const id = recordIdentity(raw, 'id')
        if (id) this.states.set(id, { connection: 'disabled', error: validated.error })
        continue
      }
      const connection = validated.record
      this.validatedIds.add(connection.id)
      if (connection.enabled) this.connect(connection)
      else this.states.set(connection.id, { connection: 'disabled' })
    }
  }

  list(): ManagedDeviceConnection[] {
    const stored = this.stored()
    return stored.flatMap((record) =>
      record &&
      typeof record === 'object' &&
      typeof (record as Record<string, unknown>).id === 'string'
        ? [this.publicConnection(record as ManagedDeviceConnectionRecord)]
        : []
    )
  }

  /**
   * 把 GUI 手工/附近配对产生的受托管连接投影成会话选择器使用的统一状态。
   * 旧 RemoteNodeRegistry 与本列表由 IPC 层合并，前端无需知道配对来源。
   */
  statuses(): RemoteNodeStatus[] {
    return this.stored().flatMap((raw) => {
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof (raw as Record<string, unknown>).id !== 'string'
      )
        return []
      return [this.publicRemoteStatus(raw as ManagedDeviceConnectionRecord)]
    })
  }

  add(input: CreateManagedDeviceConnectionInput): ManagedDeviceConnection {
    if (!uuidPattern.test(input.authorizationId)) throw new Error('方向性授权 id 无效')
    if (!uuidPattern.test(input.controllerDeviceId)) throw new Error('控制端 deviceId 无效')
    if (input.controllerDeviceId !== this.controllerDeviceId)
      throw new Error('出站授权不属于本机控制端')
    if (!uuidPattern.test(input.managedDeviceId)) throw new Error('受托管端 deviceId 无效')
    if (
      typeof input.managedDisplayName !== 'string' ||
      !input.managedDisplayName.trim() ||
      input.managedDisplayName.length > 120
    ) {
      throw new Error('受托管端名称无效')
    }
    if (
      !Array.isArray(input.capabilities) ||
      input.capabilities.some((capability) => !capabilitySet.has(capability))
    ) {
      throw new Error('出站授权包含未知 capability')
    }
    if (
      !Array.isArray(input.allowedRoots) ||
      input.allowedRoots.some((root) => typeof root !== 'string')
    ) {
      throw new Error('出站授权 allowedRoots 无效')
    }
    const existing = this.stored()
    if (
      existing.some((item) => recordIdentity(item, 'authorizationId') === input.authorizationId)
    ) {
      throw new Error('该方向性授权已经接入')
    }
    if (
      existing.some((item) => recordIdentity(item, 'managedDeviceId') === input.managedDeviceId)
    ) {
      throw new Error('该受托管设备已经接入')
    }
    const id = randomUUID()
    validateManagedGatewayClientOptions({
      hostId: id,
      label: input.managedDisplayName,
      url: input.url,
      certificateFingerprint: input.certificateFingerprint,
      authorizationId: input.authorizationId,
      controllerDeviceId: input.controllerDeviceId,
      credential: input.credential
    })
    const now = new Date().toISOString()
    const record: ManagedDeviceConnectionRecord = {
      schemaVersion: 1,
      id,
      ...input,
      capabilities: [...new Set(input.capabilities)],
      allowedRoots: [...new Set(input.allowedRoots)],
      enabled: true,
      createdAt: now,
      updatedAt: now
    }
    this.store.set([...existing, record] as ManagedDeviceConnectionRecord[])
    this.validatedIds.add(record.id)
    this.connect(record)
    return this.publicConnection(record)
  }

  async setEnabled(id: string, enabled: boolean): Promise<ManagedDeviceConnection> {
    if (!this.validatedIds.has(id)) throw new Error('损坏或未验证的受托管设备记录不能启用')
    const record = this.update(id, (current) => ({
      ...current,
      enabled,
      updatedAt: new Date().toISOString()
    }))
    if (enabled) this.connect(record)
    else await this.disconnect(record.id, 'disabled')
    return this.publicConnection(record)
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id, 'disabled')
    this.store.set(
      this.stored().filter(
        (connection) => recordIdentity(connection, 'id') !== id
      ) as ManagedDeviceConnectionRecord[]
    )
    this.states.delete(id)
    this.validatedIds.delete(id)
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.keys()].map((id) => this.disconnect(id, 'disabled')))
  }

  private connect(record: ManagedDeviceConnectionRecord): void {
    if (this.clients.has(record.id)) return
    try {
      const client = startManagedGatewayClient({
        hostId: record.id,
        label: record.managedDisplayName,
        url: record.url,
        certificateFingerprint: record.certificateFingerprint,
        authorizationId: record.authorizationId,
        controllerDeviceId: record.controllerDeviceId,
        credential: record.credential,
        onStateChange: (connection, error) => {
          this.states.set(record.id, { connection, ...(error ? { error: error.message } : {}) })
          if (connection === 'connected') this.markConnected(record.id)
          this.emit(record.id)
          this.emitRemoteStatus(record.id)
        },
        onRuntimeStatus: (status) => {
          this.remoteStatuses.set(record.id, status)
          this.emitRemoteStatus(record.id)
        }
      })
      this.clients.set(record.id, client)
      this.federation.addHost(record.id, client.runtime)
    } catch (error) {
      this.states.set(record.id, {
        connection: 'disconnected',
        error: error instanceof Error ? error.message : String(error)
      })
      this.emit(record.id)
      this.emitRemoteStatus(record.id)
    }
  }

  private validateRecord(
    raw: unknown,
    duplicateIds: Set<string>,
    duplicateAuthorizations: Set<string>,
    duplicateDevices: Set<string>
  ): { ok: true; record: ManagedDeviceConnectionRecord } | { ok: false; error: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { ok: false, error: '出站授权记录不是对象' }
    const value = raw as Record<string, unknown>
    const id = value.id
    if (value.schemaVersion !== 1) return { ok: false, error: '出站授权 schemaVersion 无效' }
    if (typeof id !== 'string' || !uuidPattern.test(id) || id === LOCAL_HOST_ID) {
      return { ok: false, error: '出站授权 host id 无效' }
    }
    if (this.federation.hasHost(id))
      return { ok: false, error: '出站授权 host id 与现有 Runtime 冲突' }
    if (duplicateIds.has(id)) return { ok: false, error: '出站授权 host id 重复' }
    if (typeof value.authorizationId !== 'string' || !uuidPattern.test(value.authorizationId)) {
      return { ok: false, error: '方向性授权 id 无效' }
    }
    if (duplicateAuthorizations.has(value.authorizationId))
      return { ok: false, error: '方向性授权 id 重复' }
    if (
      typeof value.controllerDeviceId !== 'string' ||
      !uuidPattern.test(value.controllerDeviceId)
    ) {
      return { ok: false, error: '控制端 deviceId 无效' }
    }
    if (value.controllerDeviceId !== this.controllerDeviceId) {
      return { ok: false, error: '持久化出站授权不属于本机控制端' }
    }
    if (typeof value.managedDeviceId !== 'string' || !uuidPattern.test(value.managedDeviceId)) {
      return { ok: false, error: '受托管端 deviceId 无效' }
    }
    if (duplicateDevices.has(value.managedDeviceId))
      return { ok: false, error: '受托管端 deviceId 重复' }
    if (
      typeof value.managedDisplayName !== 'string' ||
      !value.managedDisplayName.trim() ||
      value.managedDisplayName.length > 120
    ) {
      return { ok: false, error: '受托管端名称无效' }
    }
    if (typeof value.enabled !== 'boolean') return { ok: false, error: '出站授权 enabled 无效' }
    if (
      !Array.isArray(value.capabilities) ||
      value.capabilities.some((item) => typeof item !== 'string' || !capabilitySet.has(item))
    )
      return { ok: false, error: '出站授权 capabilities 无效' }
    if (
      !Array.isArray(value.allowedRoots) ||
      value.allowedRoots.some((item) => typeof item !== 'string')
    ) {
      return { ok: false, error: '出站授权 allowedRoots 无效' }
    }
    if (
      !validTimestamp(value.createdAt) ||
      !validTimestamp(value.updatedAt) ||
      (value.lastConnectedAt !== undefined && !validTimestamp(value.lastConnectedAt))
    ) {
      return { ok: false, error: '出站授权时间字段无效' }
    }
    try {
      validateManagedGatewayClientOptions({
        hostId: id,
        label: value.managedDisplayName,
        url: String(value.url ?? ''),
        certificateFingerprint: String(value.certificateFingerprint ?? ''),
        authorizationId: value.authorizationId,
        controllerDeviceId: value.controllerDeviceId,
        credential: String(value.credential ?? '')
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, record: raw as ManagedDeviceConnectionRecord }
  }

  private async disconnect(id: string, state: ManagedDeviceConnectionState): Promise<void> {
    const client = this.clients.get(id)
    this.clients.delete(id)
    this.federation.removeHost(id)
    await client?.close()
    this.remoteStatuses.delete(id)
    this.states.set(id, { connection: state })
    this.emit(id)
    this.emitRemoteStatus(id)
  }

  private markConnected(id: string): void {
    this.update(id, (record) => ({
      ...record,
      lastConnectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }))
  }

  private update(
    id: string,
    transform: (record: ManagedDeviceConnectionRecord) => ManagedDeviceConnectionRecord
  ): ManagedDeviceConnectionRecord {
    let updated: ManagedDeviceConnectionRecord | undefined
    const next = this.stored().map((raw) => {
      if (recordIdentity(raw, 'id') !== id || !raw || typeof raw !== 'object') return raw
      const record = raw as ManagedDeviceConnectionRecord
      updated = transform(record)
      return updated
    })
    if (!updated) throw new Error('受托管设备连接不存在')
    this.store.set(next as ManagedDeviceConnectionRecord[])
    return updated
  }

  private emit(id: string): void {
    const record = this.stored().find((item) => recordIdentity(item, 'id') === id)
    if (record && typeof record === 'object') {
      this.onChange?.(this.publicConnection(record as ManagedDeviceConnectionRecord))
    }
  }

  private emitRemoteStatus(id: string): void {
    const record = this.stored().find((item) => recordIdentity(item, 'id') === id)
    if (record && typeof record === 'object') {
      this.onRemoteStatusChange?.(this.publicRemoteStatus(record as ManagedDeviceConnectionRecord))
    }
  }

  private publicRemoteStatus(record: ManagedDeviceConnectionRecord): RemoteNodeStatus {
    const connection = this.publicConnection(record)
    const runtime = this.remoteStatuses.get(record.id)
    let endpoint: URL | undefined
    try {
      endpoint = new URL(record.url)
    } catch {
      // 损坏记录已在 init 时禁用；这里仍返回可诊断状态，不能让整个列表失败。
    }
    const state =
      connection.connection === 'connected'
        ? 'connected'
        : connection.connection === 'connecting'
          ? 'connecting'
          : connection.connection === 'disabled'
            ? 'disabled'
            : runtime?.connection === 'error'
              ? 'error'
              : 'disconnected'
    return {
      id: record.id,
      label: connection.managedDisplayName,
      host: endpoint?.hostname ?? '',
      port: Number(endpoint?.port || 443),
      connection: state,
      enabled: connection.enabled,
      ...(connection.error || runtime?.error ? { error: connection.error ?? runtime?.error } : {}),
      ...(runtime?.hostVersion ? { hostVersion: runtime.hostVersion } : {}),
      ...(connection.lastConnectedAt ? { lastConnectedAt: connection.lastConnectedAt } : {}),
      ...(runtime?.agents ? { agents: runtime.agents } : {})
    }
  }

  private publicConnection(record: ManagedDeviceConnectionRecord): ManagedDeviceConnection {
    const value = record as unknown as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id : ''
    const state = this.states.get(id) ?? {
      connection: value.enabled === true ? ('disconnected' as const) : ('disabled' as const)
    }
    return {
      schemaVersion: 1,
      id,
      authorizationId: typeof value.authorizationId === 'string' ? value.authorizationId : '',
      controllerDeviceId:
        typeof value.controllerDeviceId === 'string' ? value.controllerDeviceId : '',
      managedDeviceId: typeof value.managedDeviceId === 'string' ? value.managedDeviceId : '',
      managedDisplayName:
        typeof value.managedDisplayName === 'string'
          ? value.managedDisplayName
          : '损坏的受托管设备记录',
      url: typeof value.url === 'string' ? value.url : '',
      certificateFingerprint:
        typeof value.certificateFingerprint === 'string' ? value.certificateFingerprint : '',
      capabilities: Array.isArray(value.capabilities)
        ? value.capabilities.filter(
            (item): item is ManagedDeviceConnectionRecord['capabilities'][number] =>
              typeof item === 'string' && capabilitySet.has(item)
          )
        : [],
      allowedRoots: Array.isArray(value.allowedRoots)
        ? value.allowedRoots.filter((item): item is string => typeof item === 'string')
        : [],
      enabled: value.enabled === true,
      createdAt: validTimestamp(value.createdAt) ? value.createdAt : '',
      updatedAt: validTimestamp(value.updatedAt) ? value.updatedAt : '',
      ...(validTimestamp(value.lastConnectedAt) ? { lastConnectedAt: value.lastConnectedAt } : {}),
      ...state
    }
  }

  private stored(): unknown[] {
    const value: unknown = this.store.get()
    return Array.isArray(value) ? value : []
  }
}

function duplicated(values: Array<string | undefined>): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (!value) continue
    if (seen.has(value)) duplicates.add(value)
    else seen.add(value)
  }
  return duplicates
}
