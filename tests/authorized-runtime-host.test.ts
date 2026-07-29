import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostEvent,
  ManagedDeviceAuthorizationRecord,
  ManagedDeviceIdentityRecord,
  ManagedSessionOwnership,
  RuntimeHost,
  RuntimeSessionHandle,
  WorkbenchSession
} from '../src/shared/types'
import { DeviceAuthorizationRegistry } from '../src/main/domains/runtime/device-authorization'
import {
  AuthorizedRuntimeHost,
  ManagedSessionOwnershipRegistry
} from '../src/main/domains/runtime/authorized-runtime-host'
import { RemoteNodeRegistry } from '../src/main/domains/runtime/remote-registry'
import type { FederatedRuntimeHost } from '../src/main/domains/runtime/federated-runtime-host'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function session(id: string, terminalSessionId: string | null, workspacePath: string): WorkbenchSession {
  return {
    id,
    name: id,
    toolId: 'claude',
    workspacePath,
    terminalSessionId,
    nativeSessionId: null,
    surface: 'terminal',
    permissionPreset: 'safe',
    favorite: false,
    pinned: false,
    createdAt: '2026-07-19T08:00:00.000Z',
    updatedAt: '2026-07-19T08:00:00.000Z'
  }
}

function fixture() {
  let identity: ManagedDeviceIdentityRecord | null = null
  let authorizations: ManagedDeviceAuthorizationRecord[] = []
  let ownershipRecords: ManagedSessionOwnership[] = []
  const auth = new DeviceAuthorizationRegistry({
    getIdentity: () => identity,
    setIdentity: (value) => { identity = value },
    getAuthorizations: () => authorizations,
    setAuthorizations: (value) => { authorizations = value }
  }, { displayName: 'Managed Mac' })
  const controllerKey = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { format: 'pem', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }
  }).publicKey
  const root = mkdtempSync(join(tmpdir(), 'agentos-authorized-runtime-'))
  temporaryDirectories.push(root)
  const allowed = join(root, 'allowed')
  const project = join(allowed, 'project')
  const outside = join(root, 'outside')
  mkdirSync(project, { recursive: true })
  mkdirSync(outside)
  symlinkSync(outside, join(allowed, 'escape'))
  const attachment = join(project, 'input.txt')
  const outsideAttachment = join(outside, 'secret.txt')
  writeFileSync(attachment, 'ok')
  writeFileSync(outsideAttachment, 'secret')
  const grant = auth.grant({
    controllerDeviceId: 'controller-device-0001',
    controllerDisplayName: 'Controller',
    controllerPublicKey: controllerKey,
    capabilities: [
      'runtime:status', 'runtime:list-agents', 'directory:list', 'session:create',
      'session:read', 'session:write', 'session:terminate'
    ],
    allowedRoots: [allowed]
  })
  const ownerships = new ManagedSessionOwnershipRegistry({
    get: () => ownershipRecords,
    set: (value) => { ownershipRecords = value }
  })
  const created = session('remote-session', 'remote-terminal', project)
  // 故意让本机会话 id 与远程 PTY id、以及本机 PTY id 与远程会话 id 相同，
  // 证明两类 id 使用独立所有权命名空间。
  const local = session('remote-terminal', 'remote-session', project)
  const listeners = new Set<(event: HostEvent) => void>()
  const runtime = {
    hello: vi.fn(async () => ({ protocolVersion: 9, hostVersion: '0.3.0', runtimeBuildId: 'build' })),
    hostStatus: vi.fn(async () => ({
      protocolVersion: 9, hostVersion: '0.3.0', runtimeBuildId: 'build',
      mode: 'daemon', connection: 'connected', sessionCount: 99
    })),
    listRuntimes: vi.fn(async () => [{
      toolId: 'claude', displayName: 'Claude', channel: 'pty', canResume: true,
      executablePath: '/secret/bin/claude', health: 'healthy',
      capabilities: {
        terminal: true, chat: true, terminalResume: true,
        chatContinuation: 'native', linkedTerminal: true, attachments: { images: true, files: true }
      }
    }]),
    listModels: vi.fn(async () => ({
      models: [],
      source: 'unavailable' as const,
      supportsCustomModel: true
    })),
    listDirectories: vi.fn(async () => ({
      path: allowed,
      home: root,
      parent: root,
      entries: [
        { name: 'project', path: project, hidden: false },
        { name: 'escape', path: join(allowed, 'escape'), hidden: false }
      ]
    })),
    listSessions: vi.fn(async () => [created, local]),
    listSessionViews: vi.fn(async () => []),
    createSession: vi.fn(async (): Promise<RuntimeSessionHandle> => ({
      session: created,
      terminal: {
        sessionId: 'remote-terminal', toolId: 'claude', cwd: project,
        command: 'claude', backend: 'pty', createdAt: '2026-07-19T08:00:00.000Z'
      }
    })),
    resumeSession: vi.fn(async (): Promise<RuntimeSessionHandle> => ({
      session: created,
      terminal: {
        sessionId: 'remote-terminal-resumed', toolId: 'claude', cwd: project,
        command: 'claude --resume', backend: 'pty', createdAt: '2026-07-19T08:00:00.000Z'
      }
    })),
    removeSession: vi.fn(async () => undefined),
    write: vi.fn(async () => true),
    states: vi.fn(async () => [
      { sessionId: 'remote-terminal' }, { sessionId: 'remote-session' }
    ]),
    sendTurn: vi.fn(async () => ({ status: 'idle' })),
    kill: vi.fn(async () => true),
    interruptTurn: vi.fn(async () => true),
    attach: vi.fn((_terminalSessionId: string) => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: 'pty-data', sessionId: 'remote-terminal', bytes: 'first' } as HostEvent
        yield { kind: 'pty-data', sessionId: 'remote-terminal', bytes: 'after-revoke' } as HostEvent
      }
    })),
    subscribe: vi.fn((listener: (event: HostEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
  } as unknown as RuntimeHost
  const view = new AuthorizedRuntimeHost(runtime, auth, ownerships, {
    authorizationId: grant.authorization.id,
    controllerDeviceId: 'controller-device-0001',
    credential: grant.credential
  })
  return {
    auth, grant, ownerships, runtime, view, listeners,
    allowed, project, outside, attachment, outsideAttachment, created
  }
}

describe('SPEC-032 v2 授权 Runtime 视图', () => {
  it('只返回公开 Agent 信息，任务域始终不开放', async () => {
    const { view } = fixture()
    const runtimes = await view.listRuntimes()
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0]).not.toHaveProperty('executablePath')
    await expect(view.listTasks()).rejects.toThrow('不开放任务管理')
  })

  it('目录列表移除越界 parent 和 symlink 逃逸条目', async () => {
    const { view, allowed } = fixture()
    const listing = await view.listDirectories({ path: allowed })
    expect(listing.home).toBe(realpathSync(allowed))
    expect(listing.parent).toBeUndefined()
    expect(listing.entries.map((entry) => entry.name)).toEqual(['project'])
    await expect(view.listDirectories()).resolves.toMatchObject({ home: realpathSync(allowed) })
  })

  it('创建会话后持久化会话与 terminal 所有权，并隔离本机会话', async () => {
    const { view, ownerships, runtime, project } = fixture()
    await view.createSession({ name: 'remote', toolId: 'claude', workspacePath: project, permissionPreset: 'auto' })
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      permissionPreset: 'safe', memoryUse: false, memoryGenerate: false
    }))
    expect((await view.listSessions()).map((item) => item.id)).toEqual(['remote-session'])
    await expect(view.write('remote-terminal', 'ping')).resolves.toBe(true)
    await expect(view.write('remote-session', 'ping')).rejects.toThrow('PTY 不属于当前授权')
    await expect(view.sendTurn('remote-terminal', 'collision')).rejects.toThrow('会话不属于当前授权')
    expect((await view.states()).map((item) => item.sessionId)).toEqual(['remote-terminal'])
    expect(() => ownerships.track('other-authorization', {
      session: session('other-session', null, project),
      terminal: {
        sessionId: 'remote-terminal', toolId: 'claude', cwd: project,
        command: 'claude', backend: 'pty', createdAt: '2026-07-19T08:00:00.000Z'
      }
    })).toThrow('PTY 已属于另一条远程会话')
    await expect(view.resumeSession('remote-session')).resolves.toMatchObject({
      terminal: { sessionId: 'remote-terminal-resumed' }
    })
    await expect(view.write('remote-terminal-resumed', 'ping')).resolves.toBe(true)
  })

  it('所有权可从持久化记录重建，track 冲突时清理刚创建的底层会话', async () => {
    const { view, ownerships, runtime, project, grant } = fixture()
    ownerships.track('other-authorization', {
      session: session('other-session', null, project),
      terminal: {
        sessionId: 'remote-terminal', toolId: 'claude', cwd: project,
        command: 'claude', backend: 'pty', createdAt: '2026-07-19T08:00:00.000Z'
      }
    })
    await expect(view.createSession({ name: 'remote', toolId: 'claude', workspacePath: project }))
      .rejects.toThrow('PTY 已属于另一条远程会话')
    expect(runtime.removeSession).toHaveBeenCalledWith('remote-session')

    const rebuilt = new ManagedSessionOwnershipRegistry({
      get: () => ownerships.list('other-authorization'),
      set: vi.fn()
    })
    expect(rebuilt.ownsSession('other-authorization', 'other-session')).toBe(true)
    expect(rebuilt.ownsTerminal('other-authorization', 'remote-terminal')).toBe(true)
    expect(rebuilt.ownsSession(grant.authorization.id, 'other-session')).toBe(false)
  })

  it('附件越界在调用底层 Runtime 前被拒绝', async () => {
    const { view, runtime, project, attachment, outsideAttachment } = fixture()
    await view.createSession({ name: 'remote', toolId: 'claude', workspacePath: project })
    await expect(view.sendTurn('remote-session', 'ok', [attachment])).resolves.toEqual({ status: 'idle' })
    await expect(view.sendTurn('remote-session', 'no', [outsideAttachment])).rejects.toThrow('超出授权范围')
    expect(runtime.sendTurn).toHaveBeenCalledTimes(1)
  })

  it('事件只回传当前授权资源，撤销后已有视图立即拒绝 RPC', async () => {
    const { view, auth, grant, ownerships, runtime, listeners, project } = fixture()
    await view.createSession({ name: 'remote', toolId: 'claude', workspacePath: project })
    const received: HostEvent[] = []
    view.subscribe((event) => received.push(event))
    for (const listener of listeners) {
      listener({ kind: 'pty-data', sessionId: 'local-terminal', bytes: 'secret' })
      listener({ kind: 'pty-data', sessionId: 'remote-terminal', bytes: 'ok' })
      listener({ kind: 'task-changed', event: {} as never })
    }
    expect(received).toEqual([{ kind: 'pty-data', sessionId: 'remote-terminal', bytes: 'ok' }])
    auth.setStatus(grant.authorization.id, 'revoked')
    for (const listener of listeners) {
      listener({ kind: 'pty-data', sessionId: 'remote-terminal', bytes: 'after-revoke' })
    }
    expect(received).toHaveLength(1)
    await expect(view.listSessions()).rejects.toThrow('状态为 revoked')
    await ownerships.terminate(grant.authorization.id, runtime)
    expect(runtime.kill).toHaveBeenCalledWith('remote-terminal')
    expect(runtime.kill).not.toHaveBeenCalledWith('remote-session')
    expect(runtime.interruptTurn).toHaveBeenCalledWith('remote-session')
  })

  it('attach 使用 terminal ID，撤销后已有异步流停止 yield', async () => {
    const { view, auth, grant, project } = fixture()
    await view.createSession({ name: 'remote', toolId: 'claude', workspacePath: project })
    const iterator = view.attach('remote-terminal')[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: 'pty-data', sessionId: 'remote-terminal', bytes: 'first' }
    })
    expect(() => view.attach('remote-session')).toThrow('PTY 不属于当前授权')
    auth.setStatus(grant.authorization.id, 'revoked')
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('RemoteNodeRegistry 撤销接线调用定向终止，不在暂停时误杀', async () => {
    const { auth, grant, ownerships } = fixture()
    const federation = {
      addHost: vi.fn(),
      removeHost: vi.fn(),
      kill: vi.fn(async () => true),
      interruptTurn: vi.fn(async () => true)
    } as unknown as FederatedRuntimeHost
    const terminate = vi.spyOn(ownerships, 'terminate')
    const registry = new RemoteNodeRegistry(
      federation,
      { get: () => [], set: vi.fn() },
      undefined,
      undefined,
      false,
      auth,
      ownerships
    )

    await registry.setManagedDeviceAuthorizationStatus(grant.authorization.id, 'paused')
    expect(terminate).not.toHaveBeenCalled()
    await registry.setManagedDeviceAuthorizationStatus(grant.authorization.id, 'revoked')
    expect(terminate).toHaveBeenCalledWith(grant.authorization.id, federation)
  })
})
