import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateSessionInput,
  HostEvent,
  ManagedDeviceAuthorizationRecord,
  ManagedDeviceConnectionRecord,
  ManagedDeviceIdentityRecord,
  ManagedSessionOwnership,
  RemoteNodeStatus,
  RuntimeHost,
  RuntimeSessionHandle
} from '../src/shared/types'
import {
  DeviceAuthorizationRegistry,
  type DeviceAuthorizationStore
} from '../src/main/domains/runtime/device-authorization'
import { ManagedSessionOwnershipRegistry } from '../src/main/domains/runtime/authorized-runtime-host'
import {
  RemoteNodeRegistry,
  type GatewayMaterial
} from '../src/main/domains/runtime/remote-registry'
import { generateNodeTls } from '../src/main/domains/runtime/node-tls'
import { startManagedGatewayClient } from '../src/main/domains/runtime/managed-gateway-client'
import { FederatedRuntimeHost } from '../src/main/domains/runtime/federated-runtime-host'
import { NodeGatewayServer } from '../src/main/domains/runtime/node-gateway-server'
import {
  ManagedDeviceControllerRegistry,
  mergeRemoteNodeStatuses
} from '../src/main/domains/runtime/managed-device-controller-registry'

const HTTP_PORT = 18130
const WSS_PORT = 18131
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('统一合并旧节点与 GUI 手工配对状态，并让 managed 新状态覆盖同 id 旧快照', () => {
  const status = (
    id: string,
    label: string,
    connection: RemoteNodeStatus['connection']
  ): RemoteNodeStatus => ({ id, label, host: '10.39.12.184', port: 7431, connection })
  expect(
    mergeRemoteNodeStatuses(
      [status('legacy-only', '旧节点', 'connected'), status('paired', '旧快照', 'connecting')],
      [status('paired', 'Windows 手工配对', 'connected')]
    )
  ).toEqual([
    status('legacy-only', '旧节点', 'connected'),
    status('paired', 'Windows 手工配对', 'connected')
  ])
})

class MemoryAuthorizationStore implements DeviceAuthorizationStore {
  identity: ManagedDeviceIdentityRecord | null = null
  authorizations: ManagedDeviceAuthorizationRecord[] = []
  getIdentity = (): ManagedDeviceIdentityRecord | null => this.identity
  setIdentity = (identity: ManagedDeviceIdentityRecord): void => {
    this.identity = identity
  }
  getAuthorizations = (): ManagedDeviceAuthorizationRecord[] => this.authorizations
  setAuthorizations = (authorizations: ManagedDeviceAuthorizationRecord[]): void => {
    this.authorizations = authorizations
  }
}

class GuiManagedRuntime extends EventEmitter {
  createInput?: CreateSessionInput
  write = vi.fn(async () => true)
  kill = vi.fn(async () => true)
  interruptTurn = vi.fn(async () => true)
  async hostStatus() {
    return { mode: 'daemon' as const, connection: 'connected' as const, sessionCount: 0 }
  }
  async listRuntimes() {
    return [
      {
        toolId: 'claude',
        displayName: '受托管 Claude',
        executablePath: '/secret/claude',
        channel: 'pty' as const,
        canResume: true,
        capabilities: {},
        health: 'ready' as const
      }
    ]
  }
  async listSessions() {
    return []
  }
  async listSessionViews() {
    return []
  }
  async states() {
    return []
  }
  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    this.createInput = input
    const now = new Date().toISOString()
    return {
      session: {
        id: 'gui-remote-session',
        name: input.name,
        toolId: input.toolId,
        workspacePath: input.workspacePath,
        terminalSessionId: 'gui-remote-terminal',
        nativeSessionId: null,
        surface: input.surface ?? 'terminal',
        permissionPreset: input.permissionPreset ?? 'safe',
        memoryUse: input.memoryUse,
        memoryGenerate: input.memoryGenerate,
        favorite: false,
        pinned: false,
        createdAt: now,
        updatedAt: now
      },
      terminal: {
        sessionId: 'gui-remote-terminal',
        toolId: input.toolId,
        cwd: input.workspacePath,
        command: input.toolId,
        backend: 'pty',
        createdAt: now
      }
    }
  }
  subscribe(listener: (event: HostEvent) => void): () => void {
    this.on('runtime-event', listener)
    return () => this.off('runtime-event', listener)
  }
}

function localRuntime(): RuntimeHost {
  return {
    hello: async () => ({ protocolVersion: 9, hostVersion: '0.3.0', runtimeBuildId: 'local' }),
    hostStatus: async () => ({ mode: 'daemon', connection: 'connected', sessionCount: 0 }),
    listRuntimes: async () => [],
    listModels: async () => ({
      models: [],
      source: 'unavailable' as const,
      supportsCustomModel: true
    }),
    listDirectories: async () => ({ path: '/', home: '/', entries: [] }),
    listSessions: async () => [],
    listSessionViews: async () => [],
    states: async () => [],
    listTasks: async () => [],
    subscribe: () => () => undefined
  } as unknown as RuntimeHost
}

function material(): GatewayMaterial {
  const tls = generateNodeTls('agent-os-gui-managed-e2e')
  return {
    cert: tls.cert,
    key: tls.key,
    fingerprint: tls.fingerprint,
    version: '0.3.0',
    sourceRevision: 'c'.repeat(40),
    repo: 'aiutil/agent-os',
    httpPort: HTTP_PORT,
    wssPort: WSS_PORT,
    advertiseHost: '127.0.0.1'
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待 GUI 受托管连接超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('SPEC-032 Step J3 GUI 控制端 /managed client', () => {
  it('强制 WSS/无 query/有效指纹与凭证', () => {
    const base = {
      hostId: 'managed-host',
      label: '远程 GUI',
      url: 'wss://127.0.0.1:18131/managed',
      certificateFingerprint: 'AA:'.repeat(31) + 'AA',
      authorizationId: 'authorization',
      controllerDeviceId: 'controller',
      credential: 'a'.repeat(64)
    }
    expect(() => startManagedGatewayClient({ ...base, url: 'ws://127.0.0.1/managed' })).toThrow(
      'wss://'
    )
    expect(() =>
      startManagedGatewayClient({ ...base, url: `${base.url}?credential=secret` })
    ).toThrow('无查询参数')
    expect(() => startManagedGatewayClient({ ...base, certificateFingerprint: 'AA:BB' })).toThrow(
      '指纹无效'
    )
    expect(() => startManagedGatewayClient({ ...base, credential: 'secret' })).toThrow('凭证无效')
  })

  it('损坏或重复的持久化记录不会覆盖 local Runtime，也不会发起连接', async () => {
    const controller = new DeviceAuthorizationRegistry(new MemoryAuthorizationStore(), {
      displayName: '控制端 GUI'
    }).identity()
    const local = {
      ...localRuntime(),
      listRuntimes: async () => [
        {
          toolId: 'local-only',
          displayName: 'Local Only',
          channel: 'pty' as const,
          canResume: true,
          capabilities: {},
          health: 'ready' as const
        }
      ]
    } as RuntimeHost
    const federation = new FederatedRuntimeHost(local)
    const duplicateId = randomUUID()
    const base = {
      schemaVersion: 1 as const,
      authorizationId: randomUUID(),
      controllerDeviceId: controller.deviceId,
      managedDeviceId: randomUUID(),
      managedDisplayName: '损坏记录',
      url: 'wss://127.0.0.1:9/managed',
      certificateFingerprint: 'AA:'.repeat(31) + 'AA',
      credential: 'a'.repeat(64),
      capabilities: ['runtime:status' as const],
      allowedRoots: [],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const records = [
      null,
      { ...base, id: 'local' },
      { ...base, id: duplicateId, authorizationId: randomUUID(), managedDeviceId: randomUUID() },
      { ...base, id: duplicateId, authorizationId: randomUUID(), managedDeviceId: randomUUID() },
      {
        ...base,
        id: randomUUID(),
        authorizationId: randomUUID(),
        managedDeviceId: randomUUID(),
        capabilities: null
      }
    ] as unknown as ManagedDeviceConnectionRecord[]
    const changed: string[] = []
    const registry = new ManagedDeviceControllerRegistry(
      federation,
      { get: () => records, set: () => undefined },
      controller.deviceId,
      (connection) => changed.push(connection.connection)
    )
    registry.init()
    cleanups.push(() => registry.close())

    await expect(federation.listRuntimes()).resolves.toEqual([
      expect.objectContaining({
        toolId: 'local-only',
        runtimeHostId: 'local'
      })
    ])
    expect(changed).not.toContain('connecting')
    expect(registry.list()).toHaveLength(4)
    expect(registry.list().every((connection) => connection.connection === 'disabled')).toBe(true)
    expect(JSON.stringify(registry.list())).not.toContain(base.credential)
    await expect(registry.setEnabled('local', true)).rejects.toThrow('损坏或未验证')
    await expect(federation.listRuntimes()).resolves.toEqual([
      expect.objectContaining({
        toolId: 'local-only',
        runtimeHostId: 'local'
      })
    ])
    expect(changed).not.toContain('connecting')
  })

  it('证书 pin 后接入联邦 Runtime，创建真实远程会话并在 pause→active 后自动重连', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agentos-gui-client-'))
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
    const gateway = material()
    const managedStore = new MemoryAuthorizationStore()
    const managedAuthorizations = new DeviceAuthorizationRegistry(managedStore, {
      displayName: '受托管 GUI'
    })
    const controllerAuthorizations = new DeviceAuthorizationRegistry(
      new MemoryAuthorizationStore(),
      { displayName: '控制端 GUI' }
    )
    const controllerIdentity = controllerAuthorizations.identity()
    const granted = managedAuthorizations.grant({
      controllerDeviceId: controllerIdentity.deviceId,
      controllerDisplayName: controllerIdentity.displayName,
      controllerPublicKey: controllerIdentity.publicKey,
      capabilities: [
        'runtime:status',
        'runtime:list-agents',
        'directory:list',
        'session:create',
        'session:read',
        'session:write',
        'session:terminate'
      ],
      allowedRoots: [workspace]
    })
    let ownershipRecords: ManagedSessionOwnership[] = []
    const ownerships = new ManagedSessionOwnershipRegistry({
      get: () => ownershipRecords,
      set: (records) => {
        ownershipRecords = records
      }
    })
    const managedRuntime = new GuiManagedRuntime()
    const serverRegistry = new RemoteNodeRegistry(
      { addHost() {}, removeHost() {} } as unknown as FederatedRuntimeHost,
      { get: () => [], set: () => undefined },
      undefined,
      gateway,
      true,
      managedAuthorizations,
      ownerships,
      managedRuntime as unknown as RuntimeHost
    )
    cleanups.push(() => serverRegistry.close())
    await serverRegistry.init()

    const states: string[] = []
    const errors: string[] = []
    const controllerFederation = new FederatedRuntimeHost(localRuntime())
    let controllerRecords: ManagedDeviceConnectionRecord[] = []
    const controllerRegistry = new ManagedDeviceControllerRegistry(
      controllerFederation,
      {
        get: () => controllerRecords,
        set: (records) => {
          controllerRecords = records
        }
      },
      controllerIdentity.deviceId,
      (connection) => {
        states.push(connection.connection)
        if (connection.error) errors.push(connection.error)
      }
    )
    cleanups.push(() => controllerRegistry.close())
    const connection = controllerRegistry.add({
      url: `wss://127.0.0.1:${WSS_PORT}/managed`,
      certificateFingerprint: gateway.fingerprint,
      authorizationId: granted.authorization.id,
      controllerDeviceId: controllerIdentity.deviceId,
      managedDeviceId: managedAuthorizations.identity().deviceId,
      managedDisplayName: '受托管 GUI',
      credential: granted.credential,
      capabilities: granted.authorization.capabilities,
      allowedRoots: granted.authorization.allowedRoots
    })
    expect(connection).not.toHaveProperty('credential')
    expect(JSON.stringify(controllerRegistry.list())).not.toContain(granted.credential)
    expect(controllerRecords[0].credential).toBe(granted.credential)
    await waitFor(() => states.includes('connected'))

    const runtimes = await controllerFederation.listRuntimes()
    expect(runtimes).toContainEqual(
      expect.objectContaining({
        toolId: 'claude',
        displayName: '受托管 Claude',
        runtimeHostId: connection.id
      })
    )
    expect(runtimes.find((runtime) => runtime.runtimeHostId === connection.id)).not.toHaveProperty(
      'executablePath'
    )
    expect(controllerRegistry.statuses()).toContainEqual(
      expect.objectContaining({
        id: connection.id,
        label: '受托管 GUI',
        connection: 'connected',
        enabled: true,
        agents: [expect.objectContaining({ id: 'claude', enabled: true })]
      })
    )

    const events: HostEvent[] = []
    controllerFederation.subscribe((event) => events.push(event))
    const handle = await controllerFederation.createSession({
      name: 'GUI 双机真实会话',
      toolId: 'claude',
      workspacePath: workspace,
      surface: 'terminal',
      permissionPreset: 'auto',
      memoryUse: true,
      memoryGenerate: true,
      runtimeHostId: connection.id
    })
    expect(handle.session.id).toBe('gui-remote-session')
    expect(managedRuntime.createInput).toMatchObject({
      permissionPreset: 'safe',
      memoryUse: false,
      memoryGenerate: false
    })
    await expect(controllerFederation.write('gui-remote-terminal', 'ping\n')).resolves.toBe(true)
    expect(managedRuntime.write).toHaveBeenCalledWith('gui-remote-terminal', 'ping\n')
    managedRuntime.emit('runtime-event', {
      kind: 'pty-data',
      sessionId: 'gui-remote-terminal',
      bytes: 'pong\n'
    } satisfies HostEvent)
    await waitFor(() => events.some((event) => event.kind === 'pty-data'))
    expect(events).toContainEqual({
      kind: 'pty-data',
      sessionId: 'gui-remote-terminal',
      bytes: 'pong\n'
    })

    const connectedCount = states.filter((state) => state === 'connected').length
    await serverRegistry.setManagedDeviceAuthorizationStatus(granted.authorization.id, 'paused')
    await waitFor(() => states.filter((state) => state === 'disconnected').length > 0)
    await serverRegistry.setManagedDeviceAuthorizationStatus(granted.authorization.id, 'active')
    await waitFor(() => states.filter((state) => state === 'connected').length > connectedCount)
    expect(errors).toEqual([])
    expect(managedAuthorizations.list()[0].lastConnectedAt).toEqual(expect.any(String))
    expect(controllerRegistry.list()[0].lastConnectedAt).toEqual(expect.any(String))
  })

  it('证书指纹不符时在发送授权凭证前断开', async () => {
    const gateway = material()
    const connected: string[] = []
    const server = new NodeGatewayServer(gateway, {
      lookupNodeByToken: () => null,
      registerNode: () => 'unused',
      adopt: async () => undefined,
      rollbackNode: async () => undefined,
      isNodeEnabled: () => false,
      isNodeConnected: () => false,
      adoptManaged: async () => undefined
    })
    cleanups.push(() => server.stop())
    await server.start()
    const client = startManagedGatewayClient({
      hostId: 'wrong-pin',
      label: '错误 pin',
      url: `wss://127.0.0.1:${WSS_PORT}/managed`,
      certificateFingerprint: 'AA:'.repeat(31) + 'AA',
      authorizationId: 'authorization',
      controllerDeviceId: 'controller',
      credential: 'a'.repeat(64),
      minBackoffMs: 1000,
      onStateChange: (state, error) => {
        if (error) connected.push(error.message)
        else connected.push(state)
      }
    })
    cleanups.push(() => client.close())
    await waitFor(() => connected.some((item) => item.includes('证书指纹不匹配')))
    expect(connected).not.toContain('connected')
  })

  it('认证后 Runtime RPC 未就绪会超时收口，关闭时不遗留重连', async () => {
    const gateway = material()
    const server = new NodeGatewayServer(gateway, {
      lookupNodeByToken: () => null,
      registerNode: () => 'unused',
      adopt: async () => undefined,
      rollbackNode: async () => undefined,
      isNodeEnabled: () => false,
      isNodeConnected: () => false,
      // 只确认 managed auth，故意不挂 RPC server。
      adoptManaged: async () => undefined
    })
    cleanups.push(() => server.stop())
    await server.start()
    const failures: string[] = []
    const client = startManagedGatewayClient({
      hostId: 'runtime-timeout',
      label: '未就绪 GUI',
      url: `wss://127.0.0.1:${WSS_PORT}/managed`,
      certificateFingerprint: gateway.fingerprint,
      authorizationId: 'authorization',
      controllerDeviceId: 'controller',
      credential: 'a'.repeat(64),
      runtimeInitializationTimeoutMs: 50,
      minBackoffMs: 1_000,
      onStateChange: (_state, error) => {
        if (error) failures.push(error.message)
      }
    })
    await waitFor(() => failures.includes('GUI 受托管 Runtime 初始化超时'))
    await client.close()
    const countAfterClose = failures.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(failures).toHaveLength(countAfterClose)
  })
})
