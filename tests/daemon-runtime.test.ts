import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ChatTurnState,
  HostEvent,
  RuntimeHost,
  RuntimeHostStatus,
  WorkbenchSession
} from '../src/shared/types'
import { RUNTIME_PROTOCOL_VERSION } from '../src/shared/types'
import {
  DaemonRuntimeHost,
  assertLoopbackAddress
} from '../src/main/domains/runtime/daemon-runtime-host'
import { startRuntimeDaemonServer } from '../src/main/domains/runtime/daemon-server'
import { FileSessionRepository } from '../src/main/domains/sessions/file-repository'
import { acquireDaemonSpawnLock } from '../src/main/domains/runtime/daemon-spawn-lock'

const tempDirs: string[] = []
const servers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function session(overrides: Partial<WorkbenchSession> = {}): WorkbenchSession {
  return {
    id: 'session-1',
    name: 'Daemon session',
    toolId: 'shell',
    workspacePath: '/tmp',
    terminalSessionId: null,
    nativeSessionId: null,
    surface: 'terminal',
    permissionPreset: 'safe',
    favorite: false,
    pinned: false,
    segments: [],
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
    ...overrides
  }
}

class FakeRuntimeHost extends EventEmitter implements RuntimeHost {
  async hello() {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      hostVersion: '0.1.0',
      runtimeBuildId: 'test-build'
    }
  }
  async hostStatus(): Promise<RuntimeHostStatus> {
    return {
      mode: 'daemon',
      connection: 'connected',
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      hostVersion: '0.1.0',
      runtimeBuildId: 'test-build',
      sessionCount: 1,
      pid: 1234
    }
  }
  async listRuntimes() {
    return []
  }
  async listModels() {
    return { models: [], source: 'unavailable' as const, supportsCustomModel: true }
  }
  async listDirectories() {
    return { path: '/tmp', home: '/tmp', entries: [] }
  }
  async listSessions() {
    return [session()]
  }
  async listSessionViews() {
    return [
      {
        ...session(),
        status: 'running' as const,
        outputTail: '',
        lastActivityAt: '',
        continuity: { state: 'binding' as const }
      }
    ]
  }
  async createSession(): Promise<never> {
    throw new Error('not used')
  }
  async resumeSession(): Promise<never> {
    throw new Error('not used')
  }
  async openLinkedTerminal(): Promise<never> {
    throw new Error('not used')
  }
  async updateSession() {
    return null
  }
  async removeSession() {}
  async write(_sessionId: string, data: string) {
    return data === 'hello'
  }
  async resize() {
    return true
  }
  async history() {
    return 'history'
  }
  async state() {
    return null
  }
  async states() {
    return []
  }
  async kill() {
    return true
  }
  async sendTurn(sessionId: string, text: string): Promise<ChatTurnState> {
    return {
      sessionId,
      turnId: 'logical-turn-1',
      status: text ? 'running' : 'idle',
      startedAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
      pendingPermission: null,
      error: null,
      queuedCount: 0
    }
  }
  async steerTurn(sessionId: string, text: string): Promise<ChatTurnState> {
    return this.sendTurn(sessionId, text)
  }
  async queueTurn(sessionId: string, text: string) {
    const now = '2026-06-12T00:00:00.000Z'
    return {
      id: 'queued-1',
      sessionId,
      text,
      files: [],
      status: 'queued' as const,
      createdAt: now,
      updatedAt: now
    }
  }
  async listQueuedTurns() {
    return []
  }
  async cancelQueuedTurn() {
    return true
  }
  async interruptTurn() {
    return true
  }
  async respondPermission(
    sessionId: string,
    _requestId: string,
    _decision: 'once' | 'always' | 'deny'
  ): Promise<ChatTurnState> {
    return {
      sessionId,
      status: 'running',
      startedAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
      pendingPermission: null,
      error: null,
      queuedCount: 0
    }
  }
  async chatState(sessionId: string): Promise<ChatTurnState> {
    return {
      sessionId,
      status: 'idle',
      startedAt: null,
      updatedAt: '2026-06-12T00:00:00.000Z',
      pendingPermission: null,
      error: null,
      queuedCount: 0
    }
  }
  async chatHistory() {
    return []
  }
  async chatTimeline() {
    return []
  }
  async listTasks() {
    return []
  }
  async listTaskRuns() {
    return []
  }
  async createTask(): Promise<never> {
    throw new Error('not used')
  }
  async updateTask() {
    return null
  }
  async removeTask() {}
  async runTaskNow(): Promise<never> {
    throw new Error('not used')
  }
  attach(): AsyncIterable<HostEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined })
      })
    }
  }
  subscribe(listener: (event: HostEvent) => void): () => void {
    this.on('host-event', listener)
    return () => this.off('host-event', listener)
  }
  emitHost(event: HostEvent): void {
    this.emit('host-event', event)
  }
}

async function start(token = 'test-token', protocolVersion = RUNTIME_PROTOCOL_VERSION) {
  const runtime = new FakeRuntimeHost()
  const server = await startRuntimeDaemonServer({
    runtime,
    token,
    hostVersion: '0.1.0',
    runtimeBuildId: 'test-build',
    protocolVersion,
    host: '127.0.0.1',
    port: 0
  })
  servers.push(server)
  return { runtime, server }
}

describe('daemon transport security and contract', () => {
  it('uses protocol v9 for native model catalogs and attachment capabilities', () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe(10)
  })

  it('accepts only loopback bind addresses', () => {
    expect(() => assertLoopbackAddress('127.0.0.1')).not.toThrow()
    expect(() => assertLoopbackAddress('::1')).not.toThrow()
    expect(() => assertLoopbackAddress('0.0.0.0')).toThrow('localhost')
    expect(() => assertLoopbackAddress('192.168.1.10')).toThrow('localhost')
  })

  it('negotiates protocol and proxies RuntimeHost calls', async () => {
    const { server } = await start()
    const client = await DaemonRuntimeHost.connect({
      url: `ws://127.0.0.1:${server.port}`,
      token: 'test-token',
      expectedProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      expectedHostVersion: '0.1.0',
      expectedRuntimeBuildId: 'test-build'
    })

    await expect(client.hello()).resolves.toEqual({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      hostVersion: '0.1.0',
      runtimeBuildId: 'test-build'
    })
    await expect(client.listSessions()).resolves.toEqual([session()])
    await expect(client.write('terminal-1', 'hello')).resolves.toBe(true)
    await expect(client.sendTurn('session-1', 'hello')).resolves.toMatchObject({
      sessionId: 'session-1',
      turnId: 'logical-turn-1',
      status: 'running'
    })
    await expect(
      client.steerTurn('session-1', 'correct course', ['/tmp/context.txt'])
    ).resolves.toMatchObject({
      sessionId: 'session-1',
      turnId: 'logical-turn-1',
      status: 'running'
    })
    await expect(client.interruptTurn('session-1')).resolves.toBe(true)
    await expect(client.respondPermission('session-1', 'request-1', 'once')).resolves.toMatchObject(
      { status: 'running' }
    )
    await client.close()
  })

  it('rejects a wrong token, protocol mismatch, and host version mismatch', async () => {
    const first = await start('correct-token')
    await expect(
      DaemonRuntimeHost.connect({
        url: `ws://127.0.0.1:${first.server.port}`,
        token: 'wrong-token',
        expectedProtocolVersion: RUNTIME_PROTOCOL_VERSION
      })
    ).rejects.toThrow('鉴权')

    const second = await start('test-token', RUNTIME_PROTOCOL_VERSION + 1)
    await expect(
      DaemonRuntimeHost.connect({
        url: `ws://127.0.0.1:${second.server.port}`,
        token: 'test-token',
        expectedProtocolVersion: RUNTIME_PROTOCOL_VERSION
      })
    ).rejects.toThrow('协议版本')

    const third = await start()
    await expect(
      DaemonRuntimeHost.connect({
        url: `ws://127.0.0.1:${third.server.port}`,
        token: 'test-token',
        expectedProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        expectedHostVersion: '0.2.0'
      })
    ).rejects.toThrow('主程序版本')
  })

  it('forwards host events over the daemon connection', async () => {
    const { runtime, server } = await start()
    const client = await DaemonRuntimeHost.connect({
      url: `ws://127.0.0.1:${server.port}`,
      token: 'test-token',
      expectedProtocolVersion: RUNTIME_PROTOCOL_VERSION
    })
    const events: HostEvent[] = []
    const unsubscribe = client.subscribe((event) => events.push(event))

    runtime.emitHost({ kind: 'pty-data', sessionId: 'terminal-1', bytes: 'hello' })
    runtime.emitHost({
      kind: 'agent-event',
      sessionId: 'session-1',
      event: { kind: 'turn-end', status: 'completed' },
      turnId: 'logical-turn-1'
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events).toEqual([
      { kind: 'pty-data', sessionId: 'terminal-1', bytes: 'hello' },
      {
        kind: 'agent-event',
        sessionId: 'session-1',
        event: { kind: 'turn-end', status: 'completed' },
        turnId: 'logical-turn-1'
      }
    ])
    unsubscribe()
    await client.close()
  })
})

describe('FileSessionRepository', () => {
  it('migrates initial sessions and persists daemon-owned updates atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-daemon-sessions-'))
    tempDirs.push(dir)
    const file = join(dir, 'sessions.json')
    const repository = new FileSessionRepository(file, [session()])

    expect(repository.listSessions()).toEqual([
      expect.objectContaining({
        ...session(),
        mode: 'cli',
        chatHistory: [],
        linkedSessionId: null
      })
    ])
    expect(repository.updateSession('session-1', { name: 'Renamed' })?.name).toBe('Renamed')

    const reloaded = new FileSessionRepository(file)
    expect(reloaded.getSession('session-1')?.name).toBe('Renamed')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      sessions: [expect.objectContaining({ id: 'session-1', name: 'Renamed' })]
    })
  })

  it('migrates legacy arrays once, normalizes empty cwd, and keeps a backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-session-migration-'))
    tempDirs.push(dir)
    const file = join(dir, 'sessions.json')
    writeFileSync(file, JSON.stringify([session({ workspacePath: '', segments: undefined })]))

    const repository = new FileSessionRepository(file)
    expect(repository.getSession('session-1')).toMatchObject({
      workspacePath: homedir(),
      mode: 'cli',
      segments: [],
      chatHistory: [],
      linkedSessionId: null
    })
    expect(existsSync(`${file}.v1.bak`)).toBe(true)
    const backup = readFileSync(`${file}.v1.bak`, 'utf8')

    new FileSessionRepository(file)
    expect(readFileSync(`${file}.v1.bak`, 'utf8')).toBe(backup)
    expect(JSON.parse(readFileSync(file, 'utf8')).schemaVersion).toBe(2)
  })

  it('marks unfinished streamed replies as interrupted after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-chat-restart-'))
    tempDirs.push(dir)
    const file = join(dir, 'sessions.json')
    const repository = new FileSessionRepository(file, [
      session({
        surface: 'chat',
        chatHistory: [
          {
            id: 'assistant-1',
            role: 'assistant',
            text: 'partial',
            status: 'streaming',
            createdAt: '2026-06-12T00:00:00.000Z',
            updatedAt: '2026-06-12T00:00:01.000Z'
          }
        ]
      })
    ])

    repository.markInterruptedChatMessages()

    expect(repository.listChatHistory('session-1')[0]).toMatchObject({
      text: 'partial',
      status: 'interrupted'
    })
  })
})

describe('daemon spawn lock', () => {
  it('serializes competing Electron supervisors and reclaims stale locks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-daemon-lock-'))
    tempDirs.push(dir)
    const file = join(dir, 'daemon.spawn.lock')
    const first = await acquireDaemonSpawnLock(file, 100)
    const waiting = acquireDaemonSpawnLock(file, 500)
    await new Promise((resolve) => setTimeout(resolve, 20))
    first.release()

    const second = await waiting
    second.release()

    writeFileSync(file, '0', { mode: 0o600 })
    const reclaimed = await acquireDaemonSpawnLock(file, 100)
    reclaimed.release()
  })
})
