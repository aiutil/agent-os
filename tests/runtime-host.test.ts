import { describe, expect, it, vi } from 'vitest'
import { InProcessRuntimeHost } from '../src/main/domains/runtime/in-process-runtime-host'
import { SupervisedRuntimeHost } from '../src/main/domains/runtime/supervised-runtime-host'
import type {
  RuntimeSessionRepository,
  RuntimeTasks,
  RuntimeTerminal
} from '../src/main/domains/runtime/protocol'
import type {
  AgentTask,
  ChatTurnState,
  CreateSessionInput,
  CreateTaskInput,
  ManagedChatMessage,
  ManagedChatMessageStatus,
  TerminalRunState,
  TerminalSessionInfo,
  WorkbenchSession
} from '../src/shared/types'
import { RUNTIME_PROTOCOL_VERSION } from '../src/shared/types'
import type { CliAdapter } from '../src/main/domains/adapters/types'

function workbenchSession(overrides: Partial<WorkbenchSession> = {}): WorkbenchSession {
  return {
    id: 'session-1',
    name: 'RuntimeHost',
    toolId: 'claude',
    workspacePath: '/project',
    terminalSessionId: null,
    nativeSessionId: null,
    surface: 'terminal',
    permissionPreset: 'safe',
    favorite: false,
    pinned: false,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
    ...overrides
  }
}

function terminalInfo(overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    sessionId: 'terminal-1',
    toolId: 'claude',
    cwd: '/project',
    command: 'claude',
    backend: 'pty',
    createdAt: '2026-06-12T00:00:00.000Z',
    ...overrides
  }
}

function terminalState(overrides: Partial<TerminalRunState> = {}): TerminalRunState {
  return {
    sessionId: 'terminal-1',
    toolId: 'claude',
    workspacePath: '/project',
    command: 'claude',
    status: 'running',
    backend: 'pty',
    startedAt: '2026-06-12T00:00:00.000Z',
    lastActivityAt: '2026-06-12T00:00:00.000Z',
    exitCode: null,
    outputTail: '',
    ...overrides
  }
}

function createRepository(initial: WorkbenchSession[] = []): RuntimeSessionRepository & {
  sessions: WorkbenchSession[]
} {
  const repository = {
    sessions: [...initial],
    listSessions: () => [...repository.sessions],
    getSession: (id: string) => repository.sessions.find((session) => session.id === id) ?? null,
    createSession: (input: CreateSessionInput) => {
      const created = workbenchSession({
        id: `session-${repository.sessions.length + 1}`,
        name: input.name,
        nameProvisional: input.nameProvisional,
        toolId: input.toolId,
        workspacePath: input.workspacePath,
        surface: input.surface ?? 'terminal',
        permissionPreset: input.permissionPreset ?? 'safe'
      })
      repository.sessions.unshift(created)
      return created
    },
    bindNativeSession: (id: string, nativeSessionId: string | null) =>
      replaceSession(repository, id, { nativeSessionId }),
    updateSession: (
      id: string,
      patch: {
        name?: string
        nameProvisional?: boolean
        favorite?: boolean
        surface?: 'terminal' | 'chat'
        permissionPreset?: 'safe' | 'acceptEdits' | 'auto'
      }
    ) => replaceSession(repository, id, patch),
    attachTerminal: (id: string, terminalSessionId: string | null) =>
      replaceSession(repository, id, { terminalSessionId }),
    listChatHistory: (id: string) =>
      repository.sessions.find((session) => session.id === id)?.chatHistory ?? [],
    appendChatMessage: (
      id: string,
      message: Omit<ManagedChatMessage, 'id' | 'createdAt' | 'updatedAt'>
    ) => {
      const now = new Date().toISOString()
      const created = {
        ...message,
        id: `message-${Date.now()}`,
        createdAt: now,
        updatedAt: now
      }
      const session = repository.sessions.find((item) => item.id === id)
      if (!session) throw new Error('会话不存在')
      replaceSession(repository, id, {
        chatHistory: [...(session.chatHistory ?? []), created]
      })
      return created
    },
    updateChatMessage: (
      id: string,
      messageId: string,
      patch: { text?: string; status?: ManagedChatMessageStatus }
    ) => {
      const session = repository.sessions.find((item) => item.id === id)
      const message = session?.chatHistory?.find((item) => item.id === messageId)
      if (!session || !message) return null
      const updated = { ...message, ...patch, updatedAt: new Date().toISOString() }
      replaceSession(repository, id, {
        chatHistory: session.chatHistory?.map((item) => (item.id === messageId ? updated : item))
      })
      return updated
    },
    linkSessions: (sourceId: string, linkedId: string) => {
      replaceSession(repository, sourceId, { linkedSessionId: linkedId })
      replaceSession(repository, linkedId, { linkedSessionId: sourceId })
    },
    removeSession: (id: string) => {
      repository.sessions = repository.sessions.filter((session) => session.id !== id)
    }
  }
  return repository
}

function replaceSession(
  repository: { sessions: WorkbenchSession[] },
  id: string,
  patch: Partial<WorkbenchSession>
): WorkbenchSession | null {
  const index = repository.sessions.findIndex((session) => session.id === id)
  if (index === -1) return null
  repository.sessions[index] = { ...repository.sessions[index], ...patch }
  return repository.sessions[index]
}

function createTerminal(): RuntimeTerminal & {
  opened: Array<{
    toolId: string
    cwd: string
    command: string
    env?: Record<string, string>
  }>
  writes: Array<[string, string]>
  resizes: Array<[string, number, number]>
  closed: string[]
  exitListeners: Map<string, (code: number, intentionallyClosed: boolean) => void>
  emit(channel: string, payload: unknown): void
} {
  let emit = (_channel: string, _payload: unknown): void => undefined
  return {
    opened: [],
    writes: [],
    resizes: [],
    closed: [],
    exitListeners: new Map(),
    setEmit(next) {
      emit = next
    },
    emit(channel, payload) {
      emit(channel, payload)
    },
    openSession(input) {
      this.opened.push(input)
      return terminalInfo({ command: input.command, toolId: input.toolId, cwd: input.cwd })
    },
    write(sessionId, data) {
      this.writes.push([sessionId, data])
      return true
    },
    resize(sessionId, cols, rows) {
      this.resizes.push([sessionId, cols, rows])
      return true
    },
    getHistory: () => 'history',
    getState: () => terminalState(),
    listStates: () => [terminalState()],
    close(sessionId) {
      this.closed.push(sessionId)
      return true
    },
    onExit(sessionId, listener) {
      this.exitListeners.set(sessionId, listener)
    }
  }
}

function adapter(overrides: Partial<CliAdapter> = {}): CliAdapter {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    executable: 'claude',
    versionArgs: ['--version'],
    parseVersion: () => '1.0.0',
    installHint: '',
    runtime: 'native',
    supportsSessionIdInjection: true,
    buildLaunchCommand: ({ nativeSessionId }) => `claude --session-id ${nativeSessionId}`,
    buildResumeCommand: (nativeSessionId) => `claude --resume ${nativeSessionId}`,
    headlessJson: {
      supportsPersistentStream: false,
      supportsNativeResume: true,
      attachments: { images: true, files: true },
      buildTurn: () => ({ command: 'claude', args: [], env: {} }),
      createParser: () => ({ parse: () => [] })
    },
    ...overrides
  }
}

function createHost(
  options: {
    repository?: RuntimeSessionRepository
    terminal?: RuntimeTerminal
    adapters?: CliAdapter[]
    nativeSessionExists?: () => Promise<boolean>
    getProviderEnv?: (toolId: string) => Record<string, string>
    tasks?: RuntimeTasks
    chat?: {
      history(sessionId: string): ManagedChatMessage[]
      timeline(sessionId: string): []
      state(sessionId: string): ChatTurnState
      sendTurn(sessionId: string, text: string): Promise<ChatTurnState>
      steer(sessionId: string, text: string): Promise<ChatTurnState>
      queueTurn(
        sessionId: string,
        text: string
      ): {
        id: string
        sessionId: string
        text: string
        files: string[]
        status: 'queued'
        createdAt: string
        updatedAt: string
      }
      listQueuedTurns(sessionId: string): []
      cancelQueuedTurn(sessionId: string, queuedTurnId: string): boolean
      interrupt(sessionId: string): Promise<boolean>
      respondPermission(
        sessionId: string,
        requestId: string,
        decision: 'once' | 'always' | 'deny'
      ): Promise<ChatTurnState>
    }
  } = {}
): InProcessRuntimeHost {
  const adapters = options.adapters ?? [adapter()]
  const sessions = options.repository ?? createRepository()
  return new InProcessRuntimeHost({
    terminal: options.terminal ?? createTerminal(),
    sessions,
    listRuntimes: async () => [
      {
        toolId: 'claude',
        displayName: 'Claude Code',
        channel: 'pty',
        canResume: true,
        capabilities: {
          terminal: true,
          chat: true,
          terminalResume: true,
          chatContinuation: 'native',
          linkedTerminal: true,
          attachments: { images: true, files: true }
        },
        health: 'ready',
        version: '1.0.0',
        executablePath: '/usr/local/bin/claude'
      }
    ],
    getAdapter: (toolId) => adapters.find((item) => item.id === toolId),
    observeNativeSession: async () => null,
    nativeSessionExists: options.nativeSessionExists ?? (async () => true),
    createNativeSessionId: () => 'native-1',
    getProviderEnv: options.getProviderEnv ?? (() => ({})),
    tasks: options.tasks,
    chat:
      options.chat ??
      ({
        history: (sessionId: string) => sessions.listChatHistory(sessionId),
        timeline: () => [],
        state: (sessionId: string) => ({
          sessionId,
          status: 'idle',
          startedAt: null,
          updatedAt: '2026-06-12T00:00:00.000Z',
          pendingPermission: null,
          error: null,
          queuedCount: 0
        }),
        queueTurn: (sessionId: string, text: string) => ({
          id: 'queued-1',
          sessionId,
          text,
          files: [],
          status: 'queued',
          createdAt: '2026-06-12T00:00:00.000Z',
          updatedAt: '2026-06-12T00:00:00.000Z'
        }),
        listQueuedTurns: () => [],
        cancelQueuedTurn: () => true,
        sendTurn: async (sessionId: string) => ({
          sessionId,
          status: 'running',
          startedAt: '2026-06-12T00:00:00.000Z',
          updatedAt: '2026-06-12T00:00:00.000Z',
          pendingPermission: null,
          error: null,
          queuedCount: 0
        }),
        steer: async (sessionId: string) => ({
          sessionId,
          status: 'running',
          startedAt: '2026-06-12T00:00:00.000Z',
          updatedAt: '2026-06-12T00:00:00.000Z',
          pendingPermission: null,
          error: null,
          queuedCount: 0
        }),
        interrupt: async () => true,
        respondPermission: async (sessionId: string) => ({
          sessionId,
          status: 'running',
          startedAt: '2026-06-12T00:00:00.000Z',
          updatedAt: '2026-06-12T00:00:00.000Z',
          pendingPermission: null,
          queuedCount: 0,
          error: null
        })
      } as never),
    hostVersion: '0.1.0'
  })
}

describe('InProcessRuntimeHost contract', () => {
  it('keeps task creation available when used as a supervised fallback', async () => {
    const tasks: AgentTask[] = []
    const runtimeTasks: RuntimeTasks = {
      listTasks: () => tasks,
      listTaskRuns: () => [],
      createTask: (input: CreateTaskInput) => {
        const now = '2026-07-18T10:00:00.000Z'
        const task: AgentTask = {
          id: 'fallback-task',
          title: input.title,
          prompt: input.prompt,
          workspacePath: input.workspacePath,
          assignee: input.assignee,
          boardStatus: 'todo',
          executionStatus: 'idle',
          permissionPreset: input.permissionPreset ?? 'safe',
          sessionPolicy: input.sessionPolicy ?? 'new',
          createdAt: now,
          updatedAt: now
        }
        tasks.push(task)
        return task
      },
      updateTask: () => null,
      removeTask: () => undefined,
      runTaskNow: () => {
        throw new Error('not used')
      }
    }
    const fallback = createHost({ tasks: runtimeTasks })
    const controller = { start: vi.fn(), close: vi.fn() }
    const host = await SupervisedRuntimeHost.create({
      daemonEntry: '/definitely-missing/daemon.js',
      daemonConfigFile: '/definitely-missing/daemon.json',
      sessionsFile: '/tmp/runtime-sessions.json',
      tasksFile: '/tmp/tasks.json',
      chatStoreFile: '/tmp/chat-store.sqlite',
      providerStoreFile: '/tmp/provider.json',
      hostVersion: '0.2.9',
      runtimeBuildId: 'fallback-test',
      fallback,
      fallbackTasks: controller
    })

    await expect(
      host.createTask({
        title: '降级任务',
        prompt: '验证 fallback',
        workspacePath: '/tmp',
        assignee: { toolId: 'claude' }
      })
    ).resolves.toMatchObject({ id: 'fallback-task', title: '降级任务' })
    await expect(host.listTasks()).resolves.toHaveLength(1)
    expect(controller.start).toHaveBeenCalledTimes(1)

    await host.restartDaemon()
    expect(controller.close).toHaveBeenCalledTimes(1)
    expect(controller.start).toHaveBeenCalledTimes(2)
  })

  it('reports a versioned connected in-process host and runtime capabilities', async () => {
    const host = createHost()

    await expect(host.hello()).resolves.toEqual({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      hostVersion: '0.1.0',
      runtimeBuildId: '0.1.0'
    })
    await expect(host.hostStatus()).resolves.toEqual({
      mode: 'in-process',
      connection: 'connected',
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      hostVersion: '0.1.0',
      runtimeBuildId: '0.1.0',
      sessionCount: 0
    })
    await expect(host.listRuntimes()).resolves.toEqual([
      {
        toolId: 'claude',
        displayName: 'Claude Code',
        channel: 'pty',
        canResume: true,
        capabilities: {
          terminal: true,
          chat: true,
          terminalResume: true,
          chatContinuation: 'native',
          linkedTerminal: true,
          attachments: { images: true, files: true }
        },
        health: 'ready',
        version: '1.0.0',
        executablePath: '/usr/local/bin/claude'
      }
    ])
  })

  it('creates a session with the existing injection and terminal attachment semantics', async () => {
    const repository = createRepository()
    const terminal = createTerminal()
    const host = createHost({ repository, terminal })

    const result = await host.createSession({
      name: 'New session',
      toolId: 'claude',
      workspacePath: '/project'
    })

    expect(terminal.opened).toEqual([
      {
        toolId: 'claude',
        cwd: '/project',
        command: 'claude --session-id native-1',
        env: {}
      }
    ])
    expect(result.session.nativeSessionId).toBe('native-1')
    expect(result.session.terminalSessionId).toBe('terminal-1')
    expect(result.terminal?.sessionId).toBe('terminal-1')
  })

  it('creates chat sessions without PTY and delegates chat lifecycle', async () => {
    const repository = createRepository()
    const terminal = createTerminal()
    const calls: string[] = []
    const chat = {
      history: () => [] as [],
      timeline: () => [] as [],
      state: (sessionId: string): ChatTurnState => ({
        sessionId,
        status: 'idle',
        startedAt: null,
        updatedAt: '2026-06-12T00:00:00.000Z',
        pendingPermission: null,
        error: null,
        queuedCount: 0
      }),
      queueTurn: (sessionId: string, text: string) => {
        calls.push(`queue:${sessionId}:${text}`)
        return {
          id: 'queued-1',
          sessionId,
          text,
          files: [],
          status: 'queued' as const,
          createdAt: '2026-06-12T00:00:00.000Z',
          updatedAt: '2026-06-12T00:00:00.000Z'
        }
      },
      listQueuedTurns: () => [] as [],
      cancelQueuedTurn: (sessionId: string, queuedTurnId: string) => {
        calls.push(`cancel:${sessionId}:${queuedTurnId}`)
        return true
      },
      sendTurn: async (sessionId: string, text: string): Promise<ChatTurnState> => {
        calls.push(`send:${sessionId}:${text}`)
        return { ...chat.state(sessionId), status: 'running' }
      },
      steer: async (sessionId: string, text: string): Promise<ChatTurnState> => {
        calls.push(`steer:${sessionId}:${text}`)
        return { ...chat.state(sessionId), status: 'running' }
      },
      interrupt: async (sessionId: string): Promise<boolean> => {
        calls.push(`interrupt:${sessionId}`)
        return true
      },
      respondPermission: async (
        sessionId: string,
        requestId: string,
        decision: 'once' | 'always' | 'deny'
      ): Promise<ChatTurnState> => {
        calls.push(`permission:${sessionId}:${requestId}:${decision}`)
        return { ...chat.state(sessionId), status: 'running' }
      }
    }
    const host = createHost({ repository, terminal, chat })

    const created = await host.createSession({
      name: 'Chat',
      toolId: 'claude',
      workspacePath: '/project',
      surface: 'chat',
      permissionPreset: 'safe'
    })
    expect(created.terminal).toBeNull()
    expect(created.session.surface).toBe('chat')
    expect(terminal.opened).toEqual([])

    await host.sendTurn(created.session.id, 'hello')
    await host.steerTurn(created.session.id, 'correct course')
    await host.queueTurn(created.session.id, 'queued hello')
    await host.cancelQueuedTurn(created.session.id, 'queued-1')
    await host.interruptTurn(created.session.id)
    await host.respondPermission(created.session.id, 'request-1', 'once')
    expect(calls).toEqual([
      `send:${created.session.id}:hello`,
      `steer:${created.session.id}:correct course`,
      `queue:${created.session.id}:queued hello`,
      `cancel:${created.session.id}:queued-1`,
      `interrupt:${created.session.id}`,
      `permission:${created.session.id}:request-1:once`
    ])
  })

  it('opens a linked CLI session without mutating the source chat session', async () => {
    const repository = createRepository([
      workbenchSession({
        surface: 'chat',
        nativeSessionId: 'native-existing'
      })
    ])
    const terminal = createTerminal()
    const host = createHost({ repository, terminal })

    const result = await host.openLinkedTerminal('session-1')

    expect(result.terminal?.command).toBe('claude --resume native-existing')
    expect(repository.getSession('session-1')?.surface).toBe('chat')
    expect(result.session.id).not.toBe('session-1')
    expect(repository.getSession('session-1')?.linkedSessionId).toBe(result.session.id)

    const reopened = await host.openLinkedTerminal('session-1')
    expect(reopened.session.id).toBe(result.session.id)
    expect(repository.listSessions()).toHaveLength(2)
  })

  it('injects saved provider variables only into new and resumed terminal processes', async () => {
    const repository = createRepository([workbenchSession({ nativeSessionId: 'native-existing' })])
    const terminal = createTerminal()
    const host = createHost({
      repository,
      terminal,
      getProviderEnv: () => ({
        ANTHROPIC_API_KEY: 'sk-ant-local',
        ANTHROPIC_BASE_URL: 'https://api.example.test'
      })
    })

    await host.createSession({
      name: 'New session',
      toolId: 'claude',
      workspacePath: '/project'
    })
    await host.resumeSession('session-1')

    expect(terminal.opened.map((input) => input.env)).toEqual([
      {
        ANTHROPIC_API_KEY: 'sk-ant-local',
        ANTHROPIC_BASE_URL: 'https://api.example.test'
      },
      {
        ANTHROPIC_API_KEY: 'sk-ant-local',
        ANTHROPIC_BASE_URL: 'https://api.example.test'
      }
    ])
  })

  it('resumes through the adapter and retains the native binding after a failed process', async () => {
    const repository = createRepository([workbenchSession({ nativeSessionId: 'native-existing' })])
    const terminal = createTerminal()
    const host = createHost({ repository, terminal })

    const result = await host.resumeSession('session-1')
    expect(result.terminal?.command).toBe('claude --resume native-existing')

    terminal.exitListeners.get('terminal-1')?.(1, false)
    expect(repository.getSession('session-1')?.nativeSessionId).toBe('native-existing')
    expect(repository.getSession('session-1')?.terminalSessionId).toBeNull()
  })

  it('replaces an exited PTY instead of focusing it as an active terminal', async () => {
    const repository = createRepository([
      workbenchSession({
        nativeSessionId: 'native-existing',
        terminalSessionId: 'terminal-exited'
      })
    ])
    const terminal = createTerminal()
    terminal.getState = () =>
      terminalState({ sessionId: 'terminal-exited', status: 'failed', exitCode: 1 })
    const host = createHost({ repository, terminal })

    const result = await host.resumeSession('session-1')

    expect(result.terminal?.command).toBe('claude --resume native-existing')
    expect(terminal.opened).toHaveLength(1)
    expect(repository.getSession('session-1')?.terminalSessionId).toBe('terminal-1')
  })

  it('delegates terminal operations and normalizes terminal events', async () => {
    const terminal = createTerminal()
    const host = createHost({ terminal })
    const events: unknown[] = []
    const unsubscribe = host.subscribe((event) => events.push(event))

    await expect(host.write('terminal-1', 'hello')).resolves.toBe(true)
    await expect(host.resize('terminal-1', 120, 40)).resolves.toBe(true)
    await expect(host.history('terminal-1')).resolves.toBe('history')
    await expect(host.state('terminal-1')).resolves.toEqual(terminalState())
    await expect(host.states()).resolves.toEqual([terminalState()])

    terminal.emit('terminal:data', { sessionId: 'terminal-1', data: 'hello' })
    terminal.emit('terminal:stateChanged', {
      sessionId: 'terminal-1',
      state: terminalState(),
      prevStatus: 'starting'
    })
    terminal.emit('terminal:exit', { sessionId: 'terminal-1', exitCode: 0 })
    unsubscribe()

    expect(events).toEqual([
      { kind: 'pty-data', sessionId: 'terminal-1', bytes: 'hello' },
      {
        kind: 'state',
        sessionId: 'terminal-1',
        state: terminalState(),
        prevStatus: 'starting'
      },
      { kind: 'exit', sessionId: 'terminal-1', code: 0 }
    ])
  })

  it('无 timeline item 的 turn-end 也在 HostEvent 中保留逻辑 turnId', () => {
    const host = createHost()
    const events: unknown[] = []
    const unsubscribe = host.subscribe((event) => events.push(event))
    host.emitAgentEvent(
      'session-1',
      { kind: 'turn-end', status: 'completed' },
      undefined,
      'logical-turn-1'
    )
    unsubscribe()
    expect(events).toEqual([{
      kind: 'agent-event',
      sessionId: 'session-1',
      event: { kind: 'turn-end', status: 'completed' },
      turnId: 'logical-turn-1'
    }])
  })

  it('does not derive a terminal title from raw PTY input', async () => {
    const repository = createRepository([
      workbenchSession({
        id: 'session-1',
        name: 'project 终端',
        nameProvisional: true,
        workspacePath: '/work/project',
        terminalSessionId: 'terminal-1'
      })
    ])
    const terminal = createTerminal()
    const host = createHost({ repository, terminal })

    await expect(host.write('terminal-1', '连接服务 password=demo-secret\r')).resolves.toBe(true)

    expect(repository.getSession('session-1')?.name).toBe('project 终端')
    expect(repository.getSession('session-1')?.nameProvisional).toBe(true)
    expect(terminal.writes).toEqual([['terminal-1', '连接服务 password=demo-secret\r']])
  })

  it('finalizes a provisional chat title centrally after a turn is accepted', async () => {
    const repository = createRepository([
      workbenchSession({
        surface: 'chat',
        name: 'project 会话',
        nameProvisional: true,
        workspacePath: '/work/project'
      })
    ])
    const host = createHost({ repository })

    await host.sendTurn('session-1', '你好')
    expect(repository.getSession('session-1')).toMatchObject({
      name: 'project 会话',
      nameProvisional: true
    })
    await host.sendTurn('session-1', '分析失败，token=demo-secret')

    expect(repository.getSession('session-1')).toMatchObject({
      name: '分析失败，token=••••',
      nameProvisional: false
    })
    await host.sendTurn('session-1', '这条消息不能覆盖标题')
    expect(repository.getSession('session-1')?.name).toBe('分析失败，token=••••')
  })

  it('repairs a legacy chat placeholder from the first stored user message', async () => {
    const repository = createRepository([
      workbenchSession({
        surface: 'chat',
        name: 'project 会话',
        nameProvisional: false,
        workspacePath: '/work/project',
        chatHistory: [
          {
            id: 'message-0',
            role: 'user',
            text: '你好',
            status: 'completed',
            createdAt: '2026-07-23T00:00:00.000Z',
            updatedAt: '2026-07-23T00:00:00.000Z'
          },
          {
            id: 'message-1',
            role: 'user',
            text: '深度检查会话标题',
            status: 'completed',
            createdAt: '2026-07-23T00:00:00.000Z',
            updatedAt: '2026-07-23T00:00:00.000Z'
          }
        ]
      })
    ])
    const host = createHost({ repository })

    await host.listSessionViews()

    expect(repository.getSession('session-1')).toMatchObject({
      name: '深度检查会话标题',
      nameProvisional: false
    })
  })

  it('keeps a finalized terminal session title when the user types again', async () => {
    const repository = createRepository([
      workbenchSession({
        id: 'session-1',
        name: 'SPEC-035 标题修复',
        nameProvisional: false,
        terminalSessionId: 'terminal-1'
      })
    ])
    const host = createHost({ repository })

    await expect(host.write('terminal-1', '新的提示词\r')).resolves.toBe(true)

    expect(repository.getSession('session-1')?.name).toBe('SPEC-035 标题修复')
  })

  it('attaches a cancellable event stream scoped to one terminal session', async () => {
    const terminal = createTerminal()
    const host = createHost({ terminal })
    const iterator = host.attach('terminal-1')[Symbol.asyncIterator]()
    const next = iterator.next()

    terminal.emit('terminal:data', { sessionId: 'terminal-other', data: 'ignore' })
    terminal.emit('terminal:data', { sessionId: 'terminal-1', data: 'attached' })

    await expect(next).resolves.toEqual({
      value: {
        kind: 'pty-data',
        sessionId: 'terminal-1',
        bytes: 'attached'
      },
      done: false
    })
    await iterator.return?.()
  })

  it('removes a session through the host and closes its attached terminal', async () => {
    const repository = createRepository([workbenchSession({ terminalSessionId: 'terminal-live' })])
    const terminal = createTerminal()
    const host = createHost({ repository, terminal })

    await host.removeSession('session-1')

    expect(terminal.closed).toEqual(['terminal-live'])
    expect(repository.listSessions()).toEqual([])
  })
})
