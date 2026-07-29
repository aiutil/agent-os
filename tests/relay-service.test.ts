import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayService } from '../src/main/domains/relay/service'
import type {
  ChatTurnState,
  CreateSessionInput,
  RuntimeInfo,
  RuntimeSessionHandle,
  UpdateSessionPatch,
  WorkbenchSession
} from '../src/shared/types'

const tempDirs: string[] = []

function chatState(sessionId: string): ChatTurnState {
  const now = '2026-07-02T00:00:00.000Z'
  return { sessionId, status: 'idle', startedAt: null, updatedAt: now, pendingPermission: null, error: null, queuedCount: 0 }
}

class FakeRuntime {
  sessions: WorkbenchSession[] = []
  sentTurns: Array<{ sessionId: string; text: string }> = []
  createdInputs: CreateSessionInput[] = []
  removed: string[] = []
  failSend = false

  constructor(source: WorkbenchSession) {
    this.sessions = [source]
  }

  async listSessions(): Promise<WorkbenchSession[]> {
    return this.sessions
  }

  async listRuntimes(): Promise<RuntimeInfo[]> {
    return [
      {
        toolId: 'codex',
        displayName: 'Codex',
        channel: 'pty',
        canResume: true,
        capabilities: { terminal: true, chat: true, terminalResume: true, chatContinuation: 'managed-history', linkedTerminal: true, attachments: { images: true, files: false } },
        health: 'ready'
      },
      {
        toolId: 'claude',
        displayName: 'Claude Code',
        channel: 'pty',
        canResume: true,
        capabilities: { terminal: true, chat: true, terminalResume: true, chatContinuation: 'native', linkedTerminal: true, attachments: { images: true, files: true } },
        health: 'ready'
      },
      {
        toolId: 'claude',
        displayName: 'Claude Code',
        channel: 'pty',
        canResume: true,
        capabilities: { terminal: true, chat: true, terminalResume: true, chatContinuation: 'native', linkedTerminal: true, attachments: { images: true, files: true } },
        health: 'ready',
        runtimeHostId: 'node-1',
        version: '2.1.197'
      }
    ]
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    this.createdInputs.push(input)
    const session: WorkbenchSession = {
      id: `session-${this.sessions.length + 1}`,
      name: input.name,
      toolId: input.toolId,
      workspacePath: input.workspacePath,
      terminalSessionId: null,
      nativeSessionId: null,
      surface: input.surface ?? 'chat',
      permissionPreset: input.permissionPreset ?? 'safe',
      favorite: false,
      pinned: false,
      relaySource: input.relaySource,
      relayTarget: input.relayTarget,
      rootTitle: input.rootTitle,
      model: input.model,
      runtimeHostId: input.runtimeHostId,
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z'
    }
    this.sessions = [session, ...this.sessions]
    return { session, terminal: null }
  }

  async updateSession(id: string, patch: UpdateSessionPatch): Promise<WorkbenchSession | null> {
    const index = this.sessions.findIndex((session) => session.id === id)
    if (index === -1) return null
    this.sessions[index] = { ...this.sessions[index], ...patch } as WorkbenchSession
    return this.sessions[index]
  }

  async removeSession(id: string): Promise<void> {
    this.removed.push(id)
    this.sessions = this.sessions.filter((session) => session.id !== id)
  }

  async sendTurn(sessionId: string, text: string): Promise<ChatTurnState> {
    this.sentTurns.push({ sessionId, text })
    if (this.failSend) throw new Error('inject failed')
    return chatState(sessionId)
  }

  async queueTurn(sessionId: string, text: string) {
    const now = '2026-07-02T00:00:00.000Z'
    return { id: 'queued-1', sessionId, text, files: [], status: 'queued' as const, createdAt: now, updatedAt: now }
  }

  async listQueuedTurns() {
    return []
  }

  async cancelQueuedTurn() {
    return true
  }

  async chatHistory(): Promise<never[]> {
    return []
  }

  async history(): Promise<string> {
    return ''
  }
}

function sourceSession(workspacePath: string): WorkbenchSession {
  return {
    id: 'source',
    name: '登录问题修复',
    toolId: 'codex',
    workspacePath,
    terminalSessionId: null,
    nativeSessionId: 'native-codex',
    surface: 'chat',
    permissionPreset: 'safe',
    favorite: false,
    pinned: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  }
}

function setup(): { runtime: FakeRuntime; service: RelayService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-relay-service-'))
  tempDirs.push(dir)
  const runtime = new FakeRuntime(sourceSession(dir))
  const service = new RelayService({
    runtime: runtime as never,
    getTranscript: async () => null,
    openRepair: async () => undefined,
    getGitSummary: () => 'M src/auth.ts'
  })
  return { runtime, service, dir }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RelayService', () => {
  it('creates a target chat session, injects context, and links both sessions', async () => {
    const { runtime, service, dir } = setup()

    const result = await service.start({
      sourceSessionId: 'source',
      sourceSurface: 'chat',
      targetToolId: 'claude'
    })

    const target = runtime.sessions.find((session) => session.id === result.targetSessionId)
    const source = runtime.sessions.find((session) => session.id === 'source')
    expect(target?.name).toBe('登录问题修复 / Claude Code 接力')
    expect(target?.relaySource?.sessionId).toBe('source')
    expect(source?.relayTarget?.sessionId).toBe(target?.id)
    expect(runtime.sentTurns[0]?.sessionId).toBe(target?.id)
    expect(runtime.sentTurns[0]?.text).toContain('第一条回复必须包含')
    expect(readFileSync(join(dir, '.agent-os', `relay-context-${result.relayLinkId}.md`), 'utf8')).toContain('M src/auth.ts')
  })

  it('routes relay to the selected runtime host and model', async () => {
    const { runtime, service } = setup()

    const result = await service.start({
      sourceSessionId: 'source',
      sourceSurface: 'cli',
      targetToolId: 'claude',
      targetRuntimeHostId: 'node-1',
      targetModel: 'opus'
    })

    const target = runtime.sessions.find((session) => session.id === result.targetSessionId)
    expect(runtime.createdInputs[0]?.runtimeHostId).toBe('node-1')
    expect(runtime.createdInputs[0]?.model).toBe('opus')
    expect(target?.runtimeHostId).toBe('node-1')
    expect(target?.model).toBe('opus')
  })

  it('removes the target session and leaves source unchanged when injection fails', async () => {
    const { runtime, service } = setup()
    runtime.failSend = true

    await expect(
      service.start({ sourceSessionId: 'source', sourceSurface: 'chat', targetToolId: 'claude' })
    ).rejects.toThrow('inject failed')

    expect(runtime.sessions.map((session) => session.id)).toEqual(['source'])
    expect(runtime.sessions[0]?.relayTarget).toBeUndefined()
    expect(runtime.removed).toEqual(['session-2'])
  })

  it('filters out the source agent via transcript for history-origin listTargets', async () => {
    const { runtime, dir } = setup()
    const service = new RelayService({
      runtime: runtime as never,
      getTranscript: async () =>
        ({
          toolId: 'codex',
          title: '登录问题修复',
          nativeSessionId: 'native-codex',
          cwd: dir,
          startedAt: '2026-07-02T00:00:00.000Z',
          lastActivityAt: '2026-07-02T00:00:00.000Z',
          messages: []
        }) as never,
      openRepair: async () => undefined,
      getGitSummary: () => ''
    })

    const targets = await service.listTargets('codex:native-codex')

    expect(targets.map((target) => target.toolId)).not.toContain('codex')
    expect(targets.map((target) => target.toolId)).toContain('claude')
  })
})
