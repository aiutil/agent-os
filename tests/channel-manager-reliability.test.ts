import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentTask,
  ChannelAccount,
  ChannelAccountStatus,
  ChannelAcl,
  ChannelBinding,
  ChannelPairingRequest,
  OneBotSegment,
  WorkbenchSession
} from '../src/shared/types'
import type {
  ChannelTransport,
  InboundChannelMessage,
  OnboardingCallbacks
} from '../src/main/domains/channels/transport'
import type { MaterializedAttachments } from '../src/main/domains/channels/attachments'
import { ChannelInboundInbox } from '../src/main/domains/channels/inbound-inbox'

const persisted = vi.hoisted(() => ({
  gateway: true,
  accounts: [] as ChannelAccount[],
  bindings: [] as ChannelBinding[],
  acls: {} as Record<string, ChannelAcl>,
  pairingRequests: [] as ChannelPairingRequest[]
}))

vi.mock('../src/main/store/app-store', () => ({
  getChannelAccounts: () => persisted.accounts,
  setChannelAccounts: (value: ChannelAccount[]) => {
    persisted.accounts = value
  },
  getChannelBindings: () => persisted.bindings,
  setChannelBindings: (value: ChannelBinding[]) => {
    persisted.bindings = value
  },
  getChannelAcls: () => persisted.acls,
  setChannelAcls: (value: Record<string, ChannelAcl>) => {
    persisted.acls = value
  },
  getChannelPairingRequests: () => persisted.pairingRequests,
  setChannelPairingRequests: (value: ChannelPairingRequest[]) => {
    persisted.pairingRequests = value
  },
  getChannelsGatewayEnabled: () => persisted.gateway,
  setChannelsGatewayEnabled: (value: boolean) => {
    persisted.gateway = value
  }
}))

const { ChannelManager } = await import('../src/main/domains/channels/manager')

class FakeTransport implements ChannelTransport {
  sent: Array<{ chatId: string; segments: OneBotSegment[]; streaming?: boolean }> = []
  updated: Array<{ content: string; final?: boolean }> = []
  operations: string[] = []
  starts = 0
  stops = 0
  failNextSends = 0
  materializeCalls = 0
  private messageHandler: ((message: InboundChannelMessage) => void | Promise<void>) | null = null
  private statusHandler:
    | ((accountId: string, status: ChannelAccountStatus, error?: string) => void)
    | null = null
  constructor(
    private readonly updateCapable: boolean,
    private readonly startError?: Error,
    private readonly sendError?: Error,
    private readonly updateError?: Error,
    private readonly attachmentResult?:
      | MaterializedAttachments
      | Error
      | Promise<MaterializedAttachments | Error>
  ) {}
  async start(): Promise<void> {
    this.starts += 1
    if (this.startError) throw this.startError
  }
  async stop(): Promise<void> {
    this.stops += 1
    this.operations.push('stop')
  }
  async send(input: Parameters<ChannelTransport['send']>[0]): Promise<{ messageId?: string }> {
    this.sent.push({ chatId: input.chatId, segments: input.segments, streaming: input.streaming })
    this.operations.push('send')
    if (this.failNextSends > 0) {
      this.failNextSends -= 1
      throw new Error('transient platform failure')
    }
    if (this.sendError) throw this.sendError
    return { messageId: `m-${this.sent.length}` }
  }
  onMessage(cb: (message: InboundChannelMessage) => void | Promise<void>): void {
    this.messageHandler = cb
  }
  onStatus(cb: (accountId: string, status: ChannelAccountStatus, error?: string) => void): void {
    this.statusHandler = cb
  }
  async emitMessage(message: InboundChannelMessage): Promise<void> {
    await this.messageHandler?.(message)
  }
  emitStatus(status: ChannelAccountStatus, error?: string, accountId = 'a1'): void {
    this.statusHandler?.(accountId, status, error)
  }
  canUpdate(): boolean {
    return this.updateCapable
  }
  async updateMessage(
    input: Parameters<NonNullable<ChannelTransport['updateMessage']>>[0]
  ): Promise<void> {
    this.updated.push({ content: input.content, final: input.final })
    this.operations.push(input.final ? 'update:final' : 'update')
    if (this.updateError) throw this.updateError
  }
  async materializeInboundAttachments(): Promise<MaterializedAttachments | null> {
    this.materializeCalls += 1
    const result = await this.attachmentResult
    if (result instanceof Error) throw result
    return result ?? null
  }
}

const account: ChannelAccount = {
  id: 'a1',
  platform: 'feishu',
  alias: 'bot',
  enabled: true,
  credentials: { app_id: 'cli_x', app_secret: 'secret' },
  status: 'online'
}
const binding: ChannelBinding = {
  platform: 'feishu',
  accountId: 'a1',
  chatType: 'private',
  chatId: 'chat-1',
  conversationId: 'session-1',
  toolId: 'claude',
  workspacePath: '/tmp'
}
const inbound: InboundChannelMessage = {
  deliveryId: 'feishu-message-1',
  accountId: 'a1',
  platform: 'feishu',
  chatType: 'private',
  chatId: 'chat-1',
  userId: 'owner',
  mentioned: true,
  segments: [{ type: 'text', data: { text: '执行任务' } }],
  text: '执行任务'
}

function makeManager(
  transport: FakeTransport,
  sendTurn: (sessionId: string, prompt: string, files?: string[]) => Promise<unknown>,
  interruptTurn: (sessionId: string) => Promise<unknown> = async () => undefined,
  inboundInbox?: ChannelInboundInbox
) {
  return new ChannelManager({
    transport,
    inboundInbox,
    createChannelSession: async () => ({ id: 'new' }) as WorkbenchSession,
    sendTurn,
    steerTurn: sendTurn,
    interruptTurn,
    getSession: () =>
      ({ id: 'session-1', name: '真实会话', workspacePath: '/tmp' }) as WorkbenchSession,
    listSessions: async () => [],
    listTasks: async () => [],
    createTask: async (input) => ({ id: 'task-new', ...input }) as never,
    updateTask: async () => null,
    removeTask: async () => undefined,
    updateSession: () => null,
    pickDefaultAgent: async () => ({ toolId: 'claude', workspacePath: '/tmp', name: 'Claude' }),
    listAgents: async () => [{ toolId: 'claude', workspacePath: '/tmp', name: 'Claude' }],
    emitAccountState: () => undefined,
    emitScanQr: () => undefined,
    emitScanVerification: () => undefined,
    emitScanResult: () => undefined,
    deepLinkBase: 'agentos://session'
  })
}

async function deliver(
  manager: InstanceType<typeof ChannelManager>,
  message: InboundChannelMessage = inbound
): Promise<void> {
  await (
    manager as unknown as { handleInbound(message: InboundChannelMessage): Promise<void> }
  ).handleInbound(message)
}

beforeEach(() => {
  persisted.gateway = true
  persisted.accounts = [{ ...account, health: undefined }]
  persisted.bindings = [{ ...binding }]
  persisted.acls = { a1: { mode: 'owner', ownerId: 'owner', allowlist: [] } }
  persisted.pairingRequests = []
})

describe('SPEC-034 ChannelManager 单终态可靠性', () => {
  it('渠道可切换自身会话、管理当前工作区任务并 steer 活动回合', async () => {
    const transport = new FakeTransport(false)
    const sessions: WorkbenchSession[] = [
      {
        id: 'session-1',
        name: '旧会话',
        toolId: 'claude',
        workspacePath: '/tmp',
        terminalSessionId: null,
        nativeSessionId: null,
        surface: 'chat',
        permissionPreset: 'safe',
        favorite: false,
        pinned: false,
        source: 'channel',
        channelBinding: {
          platform: 'feishu',
          accountId: 'a1',
          chatType: 'private',
          chatId: 'chat-1'
        },
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z'
      },
      {
        id: 'session-2',
        name: '新会话',
        toolId: 'codex',
        workspacePath: '/tmp',
        terminalSessionId: null,
        nativeSessionId: null,
        surface: 'chat',
        permissionPreset: 'safe',
        favorite: false,
        pinned: false,
        source: 'channel',
        channelBinding: {
          platform: 'feishu',
          accountId: 'a1',
          chatType: 'private',
          chatId: 'chat-1'
        },
        createdAt: '2026-07-23T01:00:00.000Z',
        updatedAt: '2026-07-23T01:00:00.000Z'
      }
    ]
    const task: AgentTask = {
      id: 'task-123456',
      title: '检查 ISSUE',
      prompt: '第一行\n第二行',
      workspacePath: '/tmp',
      assignee: { toolId: 'codex' },
      boardStatus: 'todo',
      executionStatus: 'idle',
      permissionPreset: 'safe',
      sessionPolicy: 'new',
      schedule: {
        kind: 'interval',
        everyMs: 30 * 60_000,
        anchorAt: '2026-07-23T00:00:00.000Z',
        timeZone: 'Asia/Shanghai',
        enabled: true,
        misfirePolicy: 'run_once',
        nextRunAt: '2026-07-23T00:30:00.000Z'
      },
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z'
    }
    const tasks = [task]
    const createTask = vi.fn(async (input) => ({
      ...task,
      id: 'task-created',
      title: input.title,
      prompt: input.prompt,
      schedule: input.schedule
    }))
    const updateTask = vi.fn(async (_id, patch) => ({ ...task, ...patch }))
    const removeTask = vi.fn(async () => undefined)
    const steerTurn = vi.fn(async () => ({ turnId: 'turn-steered' }))
    const manager = new ChannelManager({
      transport,
      createChannelSession: async () => sessions[0],
      sendTurn: async () => ({ turnId: 'turn-send' }),
      steerTurn,
      interruptTurn: async () => undefined,
      getSession: (id) => sessions.find((session) => session.id === id) ?? null,
      listSessions: async () => sessions,
      listTasks: async () => tasks,
      createTask,
      updateTask,
      removeTask,
      updateSession: () => null,
      pickDefaultAgent: async () => ({ toolId: 'claude', workspacePath: '/tmp', name: 'Claude' }),
      listAgents: async () => [{ toolId: 'claude', workspacePath: '/tmp', name: 'Claude' }],
      emitAccountState: () => undefined,
      emitScanQr: () => undefined,
      emitScanVerification: () => undefined,
      emitScanResult: () => undefined,
      deepLinkBase: 'agentos://session'
    })

    await deliver(manager, { ...inbound, text: '/sessions' })
    expect(transport.sent.at(-1)?.segments[0]).toMatchObject({
      data: { text: expect.stringContaining('新会话') }
    })
    await deliver(manager, { ...inbound, deliveryId: 'switch', text: '/session session-2' })
    expect(persisted.bindings[0].conversationId).toBe('session-2')

    await deliver(manager, {
      ...inbound,
      deliveryId: 'task-add',
      text: '/task add 每隔 30 分钟检查 ISSUE'
    })
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/tmp',
        assignee: { toolId: 'codex' },
        schedule: expect.objectContaining({ kind: 'interval', everyMs: 30 * 60_000 })
      })
    )
    await deliver(manager, { ...inbound, deliveryId: 'task-show', text: '/task show 1' })
    expect(transport.sent.at(-1)?.segments[0]).toMatchObject({
      data: { text: expect.stringContaining('第一行\n第二行') }
    })
    await deliver(manager, { ...inbound, deliveryId: 'task-pause', text: '/task pause 1' })
    expect(updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ schedule: expect.objectContaining({ enabled: false }) })
    )
    await deliver(manager, { ...inbound, deliveryId: 'task-delete', text: '/task delete 1' })
    expect(removeTask).not.toHaveBeenCalled()
    await deliver(manager, {
      ...inbound,
      deliveryId: 'task-delete-confirm',
      text: '/task delete 1 confirm'
    })
    expect(removeTask).toHaveBeenCalledWith(task.id)

    await deliver(manager, {
      ...inbound,
      deliveryId: 'steer',
      text: '/steer 先修复失败测试'
    })
    expect(steerTurn).toHaveBeenCalledWith('session-2', '先修复失败测试', undefined)
  })

  it('owner 未设置时只创建显式 pairing 请求，批准前绝不驱动 Agent', async () => {
    persisted.acls = { a1: { mode: 'owner', allowlist: [] } }
    const transport = new FakeTransport(false)
    const sendTurn = vi.fn(async () => ({ turnId: 'turn-after-approval' }))
    const manager = makeManager(transport, sendTurn)

    await deliver(manager, {
      ...inbound,
      deliveryId: 'pairing-first',
      userId: 'requester-1',
      userName: 'Alice'
    })

    expect(sendTurn).not.toHaveBeenCalled()
    expect(persisted.acls.a1.ownerId).toBeUndefined()
    expect(persisted.pairingRequests).toHaveLength(1)
    expect(persisted.pairingRequests[0]).toMatchObject({
      accountId: 'a1',
      userId: 'requester-1',
      userName: 'Alice',
      code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/)
    })
    expect(transport.sent[0].segments[0]).toMatchObject({
      type: 'text',
      data: { text: expect.stringContaining(persisted.pairingRequests[0].code) }
    })

    const approved = await manager.approvePairingRequest(persisted.pairingRequests[0].id)
    expect(approved).toEqual({ mode: 'owner', ownerId: 'requester-1', allowlist: [] })
    expect(persisted.pairingRequests).toEqual([])
    expect(transport.sent.at(-1)?.segments[0]).toMatchObject({
      type: 'text',
      data: { text: expect.stringContaining('已批准') }
    })

    await deliver(manager, { ...inbound, deliveryId: 'pairing-approved', userId: 'requester-1' })
    expect(sendTurn).toHaveBeenCalledTimes(1)
  })

  it('pairing 请求按用户复用、每账号最多三条，并拒绝批准过期请求', async () => {
    persisted.acls = { a1: { mode: 'owner', allowlist: [] } }
    const manager = makeManager(new FakeTransport(false), async () => ({ turnId: 'never' }))
    await deliver(manager, { ...inbound, deliveryId: 'p1', userId: 'u1' })
    const first = persisted.pairingRequests[0]
    await deliver(manager, { ...inbound, deliveryId: 'p1-repeat', userId: 'u1' })
    expect(persisted.pairingRequests).toHaveLength(1)
    expect(persisted.pairingRequests[0].code).toBe(first.code)
    await deliver(manager, { ...inbound, deliveryId: 'p2', userId: 'u2' })
    await deliver(manager, { ...inbound, deliveryId: 'p3', userId: 'u3' })
    await deliver(manager, { ...inbound, deliveryId: 'p4', userId: 'u4' })
    expect(persisted.pairingRequests).toHaveLength(3)

    persisted.pairingRequests[0] = {
      ...persisted.pairingRequests[0],
      expiresAt: '2000-01-01T00:00:00.000Z'
    }
    await expect(manager.approvePairingRequest(first.id)).rejects.toThrow('不存在或已过期')
    expect(persisted.pairingRequests).toHaveLength(2)
  })

  it('审批决定先落盘，平台结果通知失败也不得恢复请求或回滚 owner', async () => {
    persisted.acls = { a1: { mode: 'owner', allowlist: [] } }
    const transport = new FakeTransport(false)
    const manager = makeManager(transport, async () => ({ turnId: 'never' }))
    await deliver(manager, {
      ...inbound,
      deliveryId: 'pair-notify-failure',
      userId: 'approved-user'
    })
    const requestId = persisted.pairingRequests[0].id

    transport.failNextSends = 1
    await expect(manager.approvePairingRequest(requestId)).resolves.toEqual({
      mode: 'owner',
      ownerId: 'approved-user',
      allowlist: []
    })

    expect(persisted.acls.a1.ownerId).toBe('approved-user')
    expect(persisted.pairingRequests).toEqual([])
    expect(persisted.accounts[0].health?.lastErrorAt).toBeTruthy()
  })

  it('拒绝请求后通知原私聊，且只删除目标请求', async () => {
    persisted.acls = { a1: { mode: 'owner', allowlist: [] } }
    const transport = new FakeTransport(false)
    const manager = makeManager(transport, async () => ({ turnId: 'never' }))
    await deliver(manager, { ...inbound, deliveryId: 'reject-u1', userId: 'u1', chatId: 'dm-u1' })
    await deliver(manager, { ...inbound, deliveryId: 'reject-u2', userId: 'u2', chatId: 'dm-u2' })
    const rejected = persisted.pairingRequests.find((request) => request.userId === 'u1')!

    await manager.rejectPairingRequest(rejected.id)

    expect(persisted.pairingRequests.map((request) => request.userId)).toEqual(['u2'])
    expect(transport.sent.at(-1)?.segments[0]).toMatchObject({
      type: 'text',
      data: { text: expect.stringContaining('未批准') }
    })
    expect(transport.sent.at(-1)?.chatId).toBe('dm-u1')
  })

  it('拒绝通知失败保持拒绝决定，不恢复已删除请求', async () => {
    persisted.acls = { a1: { mode: 'owner', allowlist: [] } }
    const transport = new FakeTransport(false)
    const manager = makeManager(transport, async () => ({ turnId: 'never' }))
    await deliver(manager, { ...inbound, deliveryId: 'reject-notify-failure', userId: 'u1' })
    const requestId = persisted.pairingRequests[0].id

    transport.failNextSends = 1
    await expect(manager.rejectPairingRequest(requestId)).resolves.toBeUndefined()

    expect(persisted.pairingRequests).toEqual([])
    expect(persisted.acls.a1.ownerId).toBeUndefined()
    expect(persisted.accounts[0].health?.lastErrorAt).toBeTruthy()
  })

  it('未授权私聊返回可申请的用户 ID，不驱动 Agent', async () => {
    const transport = new FakeTransport(false)
    const sendTurn = vi.fn(async () => ({ turnId: 'should-not-start' }))
    const manager = makeManager(transport, sendTurn)

    await deliver(manager, { ...inbound, deliveryId: 'denied-private', userId: 'outsider-42' })

    expect(sendTurn).not.toHaveBeenCalled()
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0].segments).toEqual([
      expect.objectContaining({
        type: 'text',
        data: expect.objectContaining({ text: expect.stringContaining('outsider-42') })
      })
    ])
  })

  it('未授权群消息保持静默，不驱动 Agent', async () => {
    const transport = new FakeTransport(false)
    const sendTurn = vi.fn(async () => ({ turnId: 'should-not-start' }))
    const manager = makeManager(transport, sendTurn)

    await deliver(manager, {
      ...inbound,
      deliveryId: 'denied-group',
      chatType: 'group',
      userId: 'outsider-42',
      mentioned: true
    })

    expect(sendTurn).not.toHaveBeenCalled()
    expect(transport.sent).toHaveLength(0)
  })

  it('访问策略按账号校验并规范化白名单', () => {
    const manager = makeManager(new FakeTransport(false), async () => undefined)

    manager.setAcl('a1', {
      mode: 'allowlist',
      ownerId: ' owner ',
      allowlist: [' user-a ', 'user-a', 'user-b']
    })

    expect(persisted.acls.a1).toEqual({
      mode: 'allowlist',
      ownerId: 'owner',
      allowlist: ['user-a', 'user-b']
    })
    expect(() => manager.setAcl('missing', { mode: 'owner', allowlist: [] })).toThrow()
    expect(() =>
      manager.setAcl('a1', {
        mode: 'invalid',
        allowlist: []
      } as unknown as ChannelAcl)
    ).toThrow()
    expect(() =>
      manager.setAcl('a1', {
        mode: 'allowlist',
        allowlist: [42]
      } as unknown as ChannelAcl)
    ).toThrow()
  })

  it('durable inbox 对同 delivery 重投只驱动一次 Agent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-manager-inbox-'))
    try {
      const transport = new FakeTransport(false)
      const sendTurn = vi.fn(async () => ({ turnId: 'turn-1' }))
      const manager = makeManager(
        transport,
        sendTurn,
        undefined,
        new ChannelInboundInbox(join(directory, 'inbox.json'))
      )
      manager.start()
      transport.emitStatus('online')
      await Promise.all([transport.emitMessage(inbound), transport.emitMessage(inbound)])
      await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('活跃回合保持 dispatching，崩溃重启先告知不确定状态，再启动 queued 且只执行一次', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-manager-queued-restart-'))
    try {
      const file = join(directory, 'inbox.json')
      const firstTransport = new FakeTransport(false)
      const firstSendTurn = vi.fn(async () => ({ turnId: 'turn-active' }))
      const firstManager = makeManager(
        firstTransport,
        firstSendTurn,
        undefined,
        new ChannelInboundInbox(file)
      )
      firstManager.start()
      firstTransport.emitStatus('online')
      await firstTransport.emitMessage(inbound)
      await vi.waitFor(() => expect(firstSendTurn).toHaveBeenCalledTimes(1))

      const queuedMessage = {
        ...inbound,
        deliveryId: 'feishu-message-queued',
        text: '排队后重启仍执行',
        segments: [{ type: 'text' as const, data: { text: '排队后重启仍执行' } }]
      }
      await firstTransport.emitMessage(queuedMessage)
      await vi.waitFor(() => {
        expect(new ChannelInboundInbox(file).snapshot().entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'dispatching',
              message: expect.objectContaining({ deliveryId: inbound.deliveryId })
            }),
            expect.objectContaining({
              status: 'queued',
              message: expect.objectContaining({ deliveryId: 'feishu-message-queued' })
            })
          ])
        )
      })

      // 模拟进程直接退出：不调用旧 Manager.stop()，其内存队列随进程消失。
      const restartedTransport = new FakeTransport(false)
      const restartedSendTurn = vi.fn(async () => ({ turnId: 'turn-after-restart' }))
      const restartedManager = makeManager(
        restartedTransport,
        restartedSendTurn,
        undefined,
        new ChannelInboundInbox(file)
      )
      restartedManager.start()
      restartedTransport.emitStatus('online')

      await vi.waitFor(() => expect(restartedSendTurn).toHaveBeenCalledTimes(1))
      expect(restartedSendTurn).toHaveBeenCalledWith('session-1', '排队后重启仍执行', undefined)
      expect(restartedTransport.sent[0].segments[0]).toMatchObject({
        type: 'text',
        data: { text: expect.stringContaining('不会自动重跑') }
      })
      expect(new ChannelInboundInbox(file).snapshot().entries).toEqual([
        expect.objectContaining({
          status: 'dispatching',
          message: expect.objectContaining({ deliveryId: 'feishu-message-queued' })
        })
      ])

      restartedManager.handleAgentEvent(
        'session-1',
        { kind: 'turn-end', status: 'completed' },
        'turn-after-restart'
      )
      await vi.waitFor(() =>
        expect(new ChannelInboundInbox(file).snapshot().entries).toHaveLength(0)
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('durable 排队消息被 Runtime 最终拒绝时保留 recovery，不误记 completed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-manager-queued-reject-'))
    try {
      const file = join(directory, 'inbox.json')
      const transport = new FakeTransport(false)
      let calls = 0
      const sendTurn = vi.fn(async () => {
        calls += 1
        if (calls === 1) return { turnId: 'turn-active' }
        throw new Error('Runtime 未接受排队回合')
      })
      const manager = makeManager(transport, sendTurn, undefined, new ChannelInboundInbox(file))
      manager.start()
      transport.emitStatus('online')
      await transport.emitMessage(inbound)
      await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))
      await transport.emitMessage({
        ...inbound,
        deliveryId: 'feishu-message-rejected',
        text: 'Runtime 拒绝的排队消息',
        segments: [{ type: 'text', data: { text: 'Runtime 拒绝的排队消息' } }]
      })
      await vi.waitFor(() => {
        expect(
          new ChannelInboundInbox(file)
            .snapshot()
            .entries.find((entry) => entry.message.deliveryId === 'feishu-message-rejected')
        ).toMatchObject({ status: 'queued' })
      })

      manager.handleAgentEvent(
        'session-1',
        { kind: 'turn-end', status: 'completed' },
        'turn-active'
      )
      await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => {
        expect(
          new ChannelInboundInbox(file)
            .snapshot()
            .entries.find((entry) => entry.message.deliveryId === 'feishu-message-rejected')
        ).toMatchObject({
          status: 'recovery',
          message: { deliveryId: 'feishu-message-rejected' }
        })
      })
      expect(persisted.accounts[0].status).toBe('error')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('附件下载期间旧回合结束时重新读取状态，durable 消息立即启动而不滞留或反序', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-manager-attachment-race-'))
    try {
      const file = join(directory, 'inbox.json')
      let resolveAttachments!: (value: MaterializedAttachments) => void
      const delayedAttachments = new Promise<MaterializedAttachments>((resolve) => {
        resolveAttachments = resolve
      })
      const cleanup = vi.fn(async () => undefined)
      const transport = new FakeTransport(
        false,
        undefined,
        undefined,
        undefined,
        delayedAttachments
      )
      const sendTurn = vi.fn(async (_sessionId: string, prompt: string) => ({
        turnId: prompt === '执行任务' ? 'turn-active' : 'turn-attachment'
      }))
      const manager = makeManager(transport, sendTurn, undefined, new ChannelInboundInbox(file))
      manager.start()
      transport.emitStatus('online')
      await transport.emitMessage(inbound)
      await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))

      await transport.emitMessage({
        ...inbound,
        deliveryId: 'feishu-message-delayed-attachment',
        text: '带附件的后续任务',
        segments: [
          { type: 'text', data: { text: '带附件的后续任务' } },
          { type: 'file', data: { file_id: 'delayed-file' } }
        ]
      })
      await vi.waitFor(() => expect(transport.materializeCalls).toBe(1))

      manager.handleAgentEvent(
        'session-1',
        { kind: 'turn-end', status: 'completed' },
        'turn-active'
      )
      await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))
      resolveAttachments({ files: ['/tmp/delayed-file.txt'], cleanup })

      await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2))
      expect(sendTurn.mock.calls[1]).toEqual([
        'session-1',
        '带附件的后续任务',
        ['/tmp/delayed-file.txt']
      ])
      expect(new ChannelInboundInbox(file).snapshot().entries).toEqual([
        expect.objectContaining({
          status: 'dispatching',
          message: expect.objectContaining({ deliveryId: 'feishu-message-delayed-attachment' })
        })
      ])
      manager.handleAgentEvent(
        'session-1',
        { kind: 'turn-end', status: 'completed' },
        'turn-attachment'
      )
      await vi.waitFor(() =>
        expect(new ChannelInboundInbox(file).snapshot().entries).toHaveLength(0)
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('重启发现 dispatching 时不盲目重跑，只向原会话发送可见恢复通知', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-manager-recovery-'))
    try {
      const inbox = new ChannelInboundInbox(join(directory, 'inbox.json'))
      inbox.enqueue(inbound)
      inbox.markDispatching(inbox.next()!.id)
      const transport = new FakeTransport(false)
      const sendTurn = vi.fn(async () => ({ turnId: 'must-not-run' }))
      const manager = makeManager(
        transport,
        sendTurn,
        undefined,
        new ChannelInboundInbox(join(directory, 'inbox.json'))
      )
      manager.start()
      transport.emitStatus('online')

      await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
      expect(sendTurn).not.toHaveBeenCalled()
      expect(transport.sent[0].segments[0]).toMatchObject({
        type: 'text',
        data: { text: expect.stringContaining('不会自动重跑') }
      })
      expect(
        new ChannelInboundInbox(join(directory, 'inbox.json')).snapshot().entries
      ).toHaveLength(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('恢复通知发送失败时保留 recovery，不把未通知误记为 completed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-manager-recovery-fail-'))
    try {
      const file = join(directory, 'inbox.json')
      const inbox = new ChannelInboundInbox(file)
      inbox.enqueue(inbound)
      inbox.markDispatching(inbox.next()!.id)
      const transport = new FakeTransport(false, undefined, new Error('platform unavailable'))
      const manager = makeManager(
        transport,
        vi.fn(async () => undefined),
        undefined,
        new ChannelInboundInbox(file)
      )
      manager.start()
      transport.emitStatus('online')

      await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
      expect(new ChannelInboundInbox(file).snapshot().entries[0]).toMatchObject({
        status: 'recovery'
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('一个账号 recovery 失败只隔离该账号，不阻塞其他在线账号或丢失 drain 唤醒', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-manager-fairness-'))
    try {
      persisted.accounts = [
        { ...account, status: 'online' },
        { ...account, id: 'a2', alias: 'bot-2', status: 'online' }
      ]
      persisted.bindings = [
        { ...binding },
        { ...binding, accountId: 'a2', chatId: 'chat-2', conversationId: 'session-2' }
      ]
      persisted.acls = {
        a1: { mode: 'owner', ownerId: 'owner', allowlist: [] },
        a2: { mode: 'owner', ownerId: 'owner', allowlist: [] }
      }
      const file = join(directory, 'inbox.json')
      const inbox = new ChannelInboundInbox(file)
      inbox.enqueue(inbound)
      inbox.markDispatching(inbox.next()!.id)
      inbox.enqueue({
        ...inbound,
        deliveryId: 'feishu-message-2',
        accountId: 'a2',
        chatId: 'chat-2'
      })

      const transport = new FakeTransport(false)
      transport.failNextSends = 1
      const sendTurn = vi.fn(async () => ({ turnId: 'turn-a2' }))
      const manager = makeManager(transport, sendTurn, undefined, new ChannelInboundInbox(file))
      manager.start()
      transport.emitStatus('online', undefined, 'a1')
      transport.emitStatus('online', undefined, 'a2')

      await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))
      expect(sendTurn).toHaveBeenCalledWith('session-2', '执行任务', undefined)
      expect(persisted.accounts.find((item) => item.id === 'a1')?.status).toBe('error')
      expect(persisted.accounts.find((item) => item.id === 'a2')?.status).toBe('online')
      expect(new ChannelInboundInbox(file).snapshot().entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'recovery',
            message: expect.objectContaining({ accountId: 'a1' })
          }),
          expect.objectContaining({
            status: 'dispatching',
            message: expect.objectContaining({ accountId: 'a2' })
          })
        ])
      )
      manager.handleAgentEvent('session-2', { kind: 'turn-end', status: 'completed' }, 'turn-a2')
      await vi.waitFor(() => {
        expect(new ChannelInboundInbox(file).snapshot().entries).toEqual([
          expect.objectContaining({
            status: 'recovery',
            message: expect.objectContaining({ accountId: 'a1' })
          })
        ])
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('/help 可发现全部命令，未知斜杠命令不会误触发 Agent', async () => {
    const transport = new FakeTransport(false)
    const sendTurn = vi.fn(async () => undefined)
    const manager = makeManager(transport, sendTurn)

    await deliver(manager, {
      ...inbound,
      text: '/help',
      segments: [{ type: 'text', data: { text: '/help' } }]
    })
    await deliver(manager, {
      ...inbound,
      text: '/deploy production',
      segments: [{ type: 'text', data: { text: '/deploy production' } }]
    })

    expect(sendTurn).not.toHaveBeenCalled()
    const outbound = transport.sent
      .map((item) => item.segments.find((segment) => segment.type === 'text')?.data.text ?? '')
      .join('\n')
    expect(outbound).toContain('/status')
    expect(outbound).toContain('/stop')
    expect(outbound).toContain('未知命令 /deploy')
  })

  it('sendTurn 立即拒绝时更新原占位消息为失败终态，不留下永久“思考中”', async () => {
    const transport = new FakeTransport(true)
    const manager = makeManager(transport, async () => {
      throw new Error('已有进行中回合')
    })
    await deliver(manager)

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]).toMatchObject({ streaming: true })
    expect(transport.updated).toHaveLength(1)
    expect(transport.updated[0].final).toBe(true)
    expect(transport.updated[0].content).toContain('已有进行中回合')
    expect(manager.hasActiveTurn('session-1')).toBe(false)
  })

  it('无消息更新能力的平台只在 turn-end 发一次最终正文', async () => {
    const transport = new FakeTransport(false)
    const manager = makeManager(transport, async () => undefined)
    await deliver(manager)
    expect(transport.sent).toHaveLength(0)

    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: '最终答案' } as AgentEvent)
    expect(transport.sent).toHaveLength(0)
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' } as AgentEvent)
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    expect(transport.sent[0].segments).toEqual([{ type: 'text', data: { text: '最终答案' } }])
    expect(persisted.accounts[0].health?.lastTurnCompletedAt).toBeTruthy()
  })

  it('Agent 完成但最终消息发送失败时不误记为端到端已验证', async () => {
    const transport = new FakeTransport(false, undefined, new Error('平台发送失败'))
    const manager = makeManager(transport, async () => undefined)
    await deliver(manager)

    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: '最终答案' } as AgentEvent)
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' } as AgentEvent)

    await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))
    expect(persisted.accounts[0].health?.lastTurnCompletedAt).toBeUndefined()
    expect(persisted.accounts[0].health?.lastErrorAt).toBeTruthy()
  })

  it('最终 update 失败但降级 send 成功时仍记为端到端闭环', async () => {
    const transport = new FakeTransport(true, undefined, undefined, new Error('更新失败'))
    const manager = makeManager(transport, async () => undefined)
    await deliver(manager)

    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: '最终答案' } as AgentEvent)
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' } as AgentEvent)

    await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))
    expect(transport.sent).toHaveLength(2)
    expect(persisted.accounts[0].health?.lastTurnCompletedAt).toBeTruthy()
  })

  it('纯附件消息下载后以默认 prompt 和本地文件驱动 Agent，直到回合终态才清理', async () => {
    const cleanup = vi.fn(async () => undefined)
    const attachments: MaterializedAttachments = { files: ['/tmp/channel-diagram.png'], cleanup }
    const transport = new FakeTransport(false, undefined, undefined, undefined, attachments)
    const sendTurn = vi.fn(async () => undefined)
    const manager = makeManager(transport, sendTurn)
    await deliver(manager, {
      ...inbound,
      text: '',
      segments: [{ type: 'image', data: { file_id: 'image-1' } }]
    })

    expect(sendTurn).toHaveBeenCalledWith('session-1', expect.stringContaining('1 个附件'), [
      '/tmp/channel-diagram.png'
    ])
    expect(cleanup).not.toHaveBeenCalled()

    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' } as AgentEvent)
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    expect(manager.hasActiveTurn('session-1')).toBe(false)
  })

  it('附件回合启动失败时清理临时文件，下载失败则不调用 Agent', async () => {
    const cleanup = vi.fn(async () => undefined)
    const mediaMessage: InboundChannelMessage = {
      ...inbound,
      segments: [{ type: 'file', data: { file_id: 'file-1' } }]
    }
    const transport = new FakeTransport(true, undefined, undefined, undefined, {
      files: ['/tmp/channel-file.txt'],
      cleanup
    })
    const manager = makeManager(transport, async () => {
      throw new Error('启动失败')
    })
    await deliver(manager, mediaMessage)
    expect(cleanup).toHaveBeenCalledTimes(1)

    const downloadErrorTransport = new FakeTransport(
      true,
      undefined,
      undefined,
      undefined,
      new Error('平台资源已过期')
    )
    const sendTurn = vi.fn(async () => undefined)
    const second = makeManager(downloadErrorTransport, sendTurn)
    await deliver(second, mediaMessage)
    expect(sendTurn).not.toHaveBeenCalled()
    expect(downloadErrorTransport.sent.at(-1)?.segments[0]).toMatchObject({
      type: 'text',
      data: { text: expect.stringContaining('平台资源已过期') }
    })
  })

  it('流式分片跨刷新边界仍原样拼接，不丢失空格或强插段落', async () => {
    const transport = new FakeTransport(true)
    const manager = makeManager(transport, async () => undefined)
    await deliver(manager)

    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: 'Hello ' } as AgentEvent)
    await new Promise((resolve) => setTimeout(resolve, 320))
    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: 'world' } as AgentEvent)
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' } as AgentEvent)

    await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))
    expect(transport.updated.at(-1)).toEqual({ content: 'Hello world', final: true })
  })

  it('同一会话的第二条入站消息不覆盖正在运行的单气泡状态', async () => {
    const transport = new FakeTransport(true)
    const sendTurn = vi.fn(async () => undefined)
    const manager = makeManager(transport, sendTurn)
    await deliver(manager)
    await deliver(manager)

    expect(sendTurn).toHaveBeenCalledTimes(1)
    expect(manager.hasActiveTurn('session-1')).toBe(true)
    expect(transport.sent).toHaveLength(2)
    expect(transport.sent[1].segments[0]).toMatchObject({
      type: 'text',
      data: { text: expect.stringContaining('/stop') }
    })

    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' } as AgentEvent)
    await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))
  })

  it('有端到端 turnId 契约时按顺序排队，迟到旧事件不污染新气泡', async () => {
    const transport = new FakeTransport(false)
    let attempt = 0
    const sendTurn = vi.fn(async (_sessionId: string, _prompt: string, _files?: string[]) => {
      attempt += 1
      if (attempt === 1) return { turnId: 'turn-1' }
      if (attempt === 2) throw new Error('当前会话已有进行中的回合')
      return { turnId: 'turn-2' }
    })
    const manager = makeManager(transport, sendTurn)

    await deliver(manager, {
      ...inbound,
      text: '第一条',
      segments: [{ type: 'text', data: { text: '第一条' } }]
    })
    await deliver(manager, {
      ...inbound,
      text: '第二条',
      segments: [{ type: 'text', data: { text: '第二条' } }]
    })

    expect(sendTurn).toHaveBeenCalledTimes(1)
    expect(transport.sent.at(-1)?.segments[0]).toMatchObject({
      type: 'text',
      data: { text: expect.stringContaining('第 1 条') }
    })

    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: '第一答案' }, 'turn-1')
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' }, 'turn-1')
    await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(3))
    expect(sendTurn).toHaveBeenNthCalledWith(3, 'session-1', '第二条', undefined)

    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: '迟到旧正文' }, 'turn-1')
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' }, 'turn-1')
    expect(manager.hasActiveTurn('session-1')).toBe(true)

    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: '第二答案' }, 'turn-2')
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' }, 'turn-2')
    await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))

    const outbound = transport.sent
      .map((item) => item.segments.find((segment) => segment.type === 'text')?.data.text ?? '')
      .join('\n')
    expect(outbound).toContain('第一答案')
    expect(outbound).toContain('第二答案')
    expect(outbound).not.toContain('迟到旧正文')
  })

  it('sendTurn 返回前到达的事件先缓冲，turnId 确定后才渲染', async () => {
    const transport = new FakeTransport(false)
    let resolveTurn!: (value: { turnId: string }) => void
    const sendTurn = vi.fn(
      () =>
        new Promise<{ turnId: string }>((resolve) => {
          resolveTurn = resolve
        })
    )
    const manager = makeManager(transport, sendTurn)
    const delivery = deliver(manager)
    await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))

    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: '早到正文' }, 'turn-early')
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' }, 'turn-early')
    expect(transport.sent).toHaveLength(0)

    resolveTurn({ turnId: 'turn-early' })
    await delivery
    await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))
    expect(transport.sent.at(-1)?.segments[0]).toMatchObject({
      type: 'text',
      data: { text: '早到正文' }
    })
  })

  it('排队回合缺少 turnId 时终止后续队列，不降级到不可关联事件', async () => {
    const transport = new FakeTransport(false)
    let calls = 0
    const sendTurn = vi.fn(async (_sessionId: string, _prompt: string, _files?: string[]) => {
      calls += 1
      return calls === 1 ? { turnId: 'turn-1' } : {}
    })
    const manager = makeManager(transport, sendTurn)
    await deliver(manager)
    await deliver(manager, {
      ...inbound,
      text: '等待-1',
      segments: [{ type: 'text', data: { text: '等待-1' } }]
    })
    await deliver(manager, {
      ...inbound,
      text: '等待-2',
      segments: [{ type: 'text', data: { text: '等待-2' } }]
    })

    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' }, 'turn-1')
    await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))
    expect(sendTurn).toHaveBeenCalledTimes(2)
    const outbound = transport.sent
      .map((item) => item.segments.find((segment) => segment.type === 'text')?.data.text ?? '')
      .join('\n')
    expect(outbound).toContain('未返回可验证的回合 ID')
    expect(sendTurn.mock.calls.some((call) => call[1] === '等待-2')).toBe(false)
  })

  it('每会话最多排队 5 条，第 6 条不进入 Agent', async () => {
    const transport = new FakeTransport(false)
    const sendTurn = vi.fn(async () => ({ turnId: 'turn-current' }))
    const manager = makeManager(transport, sendTurn)
    await deliver(manager)
    for (let index = 1; index <= 6; index += 1) {
      await deliver(manager, {
        ...inbound,
        text: `等待-${index}`,
        segments: [{ type: 'text', data: { text: `等待-${index}` } }]
      })
    }
    expect(sendTurn).toHaveBeenCalledTimes(1)
    expect(transport.sent.at(-1)?.segments[0]).toMatchObject({
      type: 'text',
      data: { text: expect.stringContaining('5 条消息等待') }
    })
    await manager.stop()
  })

  it('/stop 中断当前回合时清空队列并释放已下载附件', async () => {
    const cleanup = vi.fn(async () => undefined)
    const transport = new FakeTransport(false, undefined, undefined, undefined, {
      files: ['/tmp/queued-channel-file.txt'],
      cleanup
    })
    const interrupt = vi.fn(async () => true)
    const manager = makeManager(transport, async () => ({ turnId: 'turn-1' }), interrupt)
    await deliver(manager)
    await deliver(manager, {
      ...inbound,
      text: '后续附件',
      segments: [{ type: 'file', data: { file_id: 'queued-file' } }]
    })
    expect(cleanup).not.toHaveBeenCalled()

    await deliver(manager, {
      ...inbound,
      text: '/stop',
      segments: [{ type: 'text', data: { text: '/stop' } }]
    })
    expect(interrupt).toHaveBeenCalledWith('session-1')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(transport.sent.at(-1)?.segments[0]).toMatchObject({
      type: 'text',
      data: { text: expect.stringContaining('已取消 1 条') }
    })
    expect(manager.hasActiveTurn('session-1')).toBe(false)
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'interrupted' }, 'turn-1')
    expect(manager.hasActiveTurn('session-1')).toBe(false)
  })

  it('/stop 收口 durable queued，重启后不会把已取消消息再次启动', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-manager-durable-stop-'))
    try {
      const file = join(directory, 'inbox.json')
      const transport = new FakeTransport(false)
      const sendTurn = vi.fn(async () => ({ turnId: 'turn-1' }))
      const manager = makeManager(
        transport,
        sendTurn,
        async () => true,
        new ChannelInboundInbox(file)
      )
      manager.start()
      transport.emitStatus('online')
      await transport.emitMessage(inbound)
      await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))
      await transport.emitMessage({
        ...inbound,
        deliveryId: 'feishu-message-cancelled',
        text: '不应在重启后执行',
        segments: [{ type: 'text', data: { text: '不应在重启后执行' } }]
      })
      await vi.waitFor(() => {
        expect(
          new ChannelInboundInbox(file)
            .snapshot()
            .entries.find((entry) => entry.message.deliveryId === 'feishu-message-cancelled')
        ).toMatchObject({ status: 'queued' })
      })

      await transport.emitMessage({
        ...inbound,
        deliveryId: 'feishu-message-stop',
        text: '/stop',
        segments: [{ type: 'text', data: { text: '/stop' } }]
      })
      await vi.waitFor(() =>
        expect(new ChannelInboundInbox(file).snapshot().entries).toHaveLength(0)
      )

      const restartedTransport = new FakeTransport(false)
      const restartedSendTurn = vi.fn(async () => ({ turnId: 'must-not-run' }))
      const restartedManager = makeManager(
        restartedTransport,
        restartedSendTurn,
        undefined,
        new ChannelInboundInbox(file)
      )
      restartedManager.start()
      restartedTransport.emitStatus('online')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(restartedSendTurn).not.toHaveBeenCalled()
      expect(sendTurn).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('禁用账号会等待同步中断终态和队列附件清理完成后再停止 transport', async () => {
    const cleanup = vi.fn(async () => undefined)
    const transport = new FakeTransport(true, undefined, undefined, undefined, {
      files: ['/tmp/queued-before-disable.txt'],
      cleanup
    })
    const managerRef = { current: null as InstanceType<typeof ChannelManager> | null }
    const interrupt = vi.fn(async () => {
      managerRef.current!.handleAgentEvent(
        'session-1',
        { kind: 'turn-end', status: 'interrupted' },
        'turn-1'
      )
      return true
    })
    const manager = makeManager(transport, async () => ({ turnId: 'turn-1' }), interrupt)
    managerRef.current = manager
    await deliver(manager)
    await deliver(manager, {
      ...inbound,
      text: '排队附件',
      segments: [{ type: 'file', data: { file_id: 'queued-before-disable' } }]
    })

    const result = await manager.setAccountEnabled('a1', false)

    expect(result).toEqual({ ok: true })
    expect(interrupt).toHaveBeenCalledWith('session-1')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(manager.hasActiveTurn('session-1')).toBe(false)
    expect(transport.stops).toBe(1)
    expect(transport.operations.indexOf('update:final')).toBeGreaterThanOrEqual(0)
    expect(transport.operations.indexOf('update:final')).toBeLessThan(
      transport.operations.indexOf('stop')
    )
  })

  it('终态发送开始后忽略迟到的同回合正文', async () => {
    const transport = new FakeTransport(true)
    const manager = makeManager(transport, async () => ({ turnId: 'turn-1' }))
    await deliver(manager)

    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: '最终答案' }, 'turn-1')
    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'completed' }, 'turn-1')
    manager.handleAgentEvent('session-1', { kind: 'text-delta', text: '迟到正文' }, 'turn-1')

    await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))
    expect(transport.updated.at(-1)?.content).toBe('最终答案')
  })

  it('中断事件会把原占位消息收口为最终态', async () => {
    const transport = new FakeTransport(true)
    const manager = makeManager(transport, async () => undefined)
    await deliver(manager)

    manager.handleAgentEvent('session-1', { kind: 'turn-end', status: 'interrupted' } as AgentEvent)

    await vi.waitFor(() => expect(manager.hasActiveTurn('session-1')).toBe(false))
    expect(transport.updated.at(-1)?.final).toBe(true)
    expect(transport.updated.at(-1)?.content).toContain('中断')
  })

  it('10 分钟无终态时自动收口，不留下永久思考中', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport(true)
      const interrupt = vi.fn(async () => true)
      const manager = makeManager(transport, async () => undefined, interrupt)
      await deliver(manager)

      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000)

      expect(interrupt).toHaveBeenCalledWith('session-1')
      expect(manager.hasActiveTurn('session-1')).toBe(false)
      expect(transport.updated.at(-1)?.final).toBe(true)
      expect(transport.updated.at(-1)?.content).toContain('10 分钟')
    } finally {
      vi.useRealTimers()
    }
  })

  it('首次 transport 鉴权失败会落为可见错误，不永久停在连接中', async () => {
    const transport = new FakeTransport(true, new Error('token 无效'))
    const manager = makeManager(transport, async () => undefined)

    const result = await manager.setAccountEnabled('a1', true)

    expect(result).toEqual({ ok: false, error: 'token 无效' })
    expect(persisted.accounts[0]).toMatchObject({ status: 'error', error: 'token 无效' })
    expect(persisted.accounts[0].health?.lastErrorAt).toBeTruthy()
  })

  it('显式重新连接会先停止残留 session 再启动，不被幂等 start 空转', async () => {
    const transport = new FakeTransport(true)
    const manager = makeManager(transport, async () => undefined)

    const result = await manager.testConnection('a1')

    expect(result.ok).toBe(true)
    expect(transport.stops).toBe(1)
    expect(transport.starts).toBe(1)
  })

  it('微信扫码的手机数字验证码在设置流程内续接，并把扫码人设为 owner', async () => {
    persisted.accounts = []
    persisted.bindings = []
    persisted.acls = {}
    class WeChatOnboardingTransport extends FakeTransport {
      async startOnboarding(callbacks: OnboardingCallbacks): Promise<{
        appId: string
        appSecret: string
        userOpenId: string
        alias: string
        extraCredentials: Record<string, string>
      }> {
        callbacks.onQrCode({ url: 'https://weixin.qq.com/q/test', expireIn: 300 })
        const code = await callbacks.requestVerificationCode?.('请输入手机微信显示的数字验证码')
        if (code !== '123456') throw new Error('验证码错误')
        return {
          appId: 'bot@im.wechat',
          appSecret: 'wechat-token',
          userOpenId: 'wx-owner',
          alias: '微信',
          extraCredentials: { base_url: 'https://ilinkai.weixin.qq.com/' }
        }
      }
    }
    const transport = new WeChatOnboardingTransport(false)
    const qrEvents: unknown[] = []
    const verificationEvents: unknown[] = []
    const scanResults: unknown[] = []
    const manager = new ChannelManager({
      transport,
      createChannelSession: async () => ({ id: 'new' }) as WorkbenchSession,
      sendTurn: async () => undefined,
      steerTurn: async () => undefined,
      interruptTurn: async () => undefined,
      getSession: () => null,
      listSessions: async () => [],
      listTasks: async () => [],
      createTask: async (input) => ({ id: 'task-new', ...input }) as never,
      updateTask: async () => null,
      removeTask: async () => undefined,
      updateSession: () => null,
      pickDefaultAgent: async () => null,
      listAgents: async () => [],
      emitAccountState: () => undefined,
      emitScanQr: (event) => qrEvents.push(event),
      emitScanVerification: (event) => verificationEvents.push(event),
      emitScanResult: (event) => scanResults.push(event),
      deepLinkBase: 'agentos://session'
    })

    const scan = manager.startChannelScan('wechat')
    await vi.waitFor(() => expect(verificationEvents).toHaveLength(1))
    manager.submitScanVerificationCode('123456')
    await scan

    expect(qrEvents).toEqual([
      { url: 'https://weixin.qq.com/q/test', expireIn: 300, platform: 'wechat' }
    ])
    expect(scanResults).toEqual([
      expect.objectContaining({ ok: true, platform: 'wechat', alias: '微信' })
    ])
    expect(persisted.accounts[0]).toMatchObject({
      platform: 'wechat',
      alias: '微信',
      credentials: {
        bot_id: 'bot@im.wechat',
        token: 'wechat-token',
        base_url: 'https://ilinkai.weixin.qq.com/',
        owner_id: 'wx-owner'
      }
    })
    expect(persisted.acls[persisted.accounts[0].id]).toEqual({
      mode: 'owner',
      ownerId: 'wx-owner',
      allowlist: []
    })
  })
})
