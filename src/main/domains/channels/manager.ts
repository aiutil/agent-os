// SPEC-034 消息渠道 —— ChannelManager（编排核心）。
// 职责：账号/绑定/ACL/网关开关的生命周期；把入站消息路由到 Conversation 并驱动
// ChatManager.sendTurn；订阅 AgentEvent（经 index.ts emit 分流注入）渲染回渠道。
// 持久化直接走 app-store（与 conversation-store 同模式）；运行时能力（建会话/跑回合/
// 中断/取会话/选默认 agent/推状态）由 index.ts 注入。

import { randomBytes, randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentTask,
  AddChannelAccountInput,
  ChannelAccount,
  ChannelAccountStatus,
  ChannelAcl,
  ChannelBinding,
  ChannelPlatform,
  ChannelPairingRequest,
  ChannelScanQr,
  ChannelScanResult,
  ChannelScanVerification,
  OneBotSegment,
  CreateTaskInput,
  UpdateTaskPatch,
  UpdateSessionPatch,
  WorkbenchSession
} from '@shared/types'
import { tr } from '@shared/i18n'
import {
  getChannelAccounts,
  setChannelAccounts,
  getChannelBindings,
  setChannelBindings,
  getChannelAcls,
  setChannelAcls,
  getChannelPairingRequests,
  setChannelPairingRequests,
  getChannelsGatewayEnabled,
  setChannelsGatewayEnabled
} from '../../store/app-store'
import type { ChannelTransport, InboundChannelMessage } from './transport'
import { cleanupStaleChannelAttachments, type MaterializedAttachments } from './attachments'
import type { ChannelInboundInbox, ChannelInboxEntry } from './inbound-inbox'
import { isAllowed } from './acl'
import { resolveBinding, findBinding, type CreateChannelSessionInput } from './router'
import { toolProgressLine, parseCommand } from './renderer'
import { parseSemanticTaskIntent } from '../tasks/semantic-schedule'

export interface ChannelManagerDeps {
  transport: ChannelTransport
  /** 生产环境注入 0600 原子 inbox；测试可省略并直接调用 handleInbound。 */
  inboundInbox?: ChannelInboundInbox
  createChannelSession(input: CreateChannelSessionInput): Promise<WorkbenchSession>
  sendTurn(sessionId: string, prompt: string, files?: string[]): Promise<unknown>
  steerTurn(sessionId: string, prompt: string, files?: string[]): Promise<unknown>
  interruptTurn(sessionId: string): Promise<unknown>
  getSession(id: string): WorkbenchSession | null
  listSessions(): Promise<WorkbenchSession[]>
  listTasks(): Promise<AgentTask[]>
  createTask(input: CreateTaskInput): Promise<AgentTask>
  updateTask(id: string, patch: UpdateTaskPatch): Promise<AgentTask | null>
  removeTask(id: string): Promise<void>
  /** SPEC-035：渲染端覆盖不到渠道会话，服务端在首条真实消息后重命名占位名。 */
  updateSession(id: string, patch: UpdateSessionPatch): WorkbenchSession | null
  pickDefaultAgent(): Promise<{ toolId: string; workspacePath: string; name: string } | null>
  /** 列出所有可用 agent（用于 /agents 展示和 /use 切换）。 */
  listAgents(): Promise<{ toolId: string; name: string; workspacePath: string }[]>
  /** 把账号状态变化推给渲染端（经 IPC 事件 channelAccountStateChanged）。 */
  emitAccountState(account: ChannelAccount): void
  /** 扫码建应用：二维码就绪 / 结果，推给渲染端。 */
  emitScanQr(qr: ChannelScanQr): void
  emitScanVerification(verification: ChannelScanVerification): void
  emitScanResult(result: ChannelScanResult): void
  /** 深链前缀，如 'agentos://session'。 */
  deepLinkBase: string
}

interface RenderState {
  sessionId: string
  accountId: string
  chatType: ChannelBinding['chatType']
  chatId: string
  /** 未提交的正文增量（节流缓冲，攒够一段时间或遇到边界就并入 committed 并更新消息）。 */
  pending: string
  /** 已写入单条消息的完整正文（update 整段覆盖的来源）。 */
  committed: string
  /** 单条可变消息 id：回合开始发占位"思考中…"时记下，后续流式 update 同一条。null=尚未发出。 */
  messageId: string | null
  /** 节流更新定时器。 */
  flushTimer: NodeJS.Timeout | null
  /** 本回合是否已发过正文（决定 turn-end 文案）。 */
  sentAny: boolean
  /** 只有最终正文实际 update/send 成功才为 true；Agent 完成不等于 IM 端已收到回复。 */
  terminalDelivered: boolean
  /** 当前回合使用的平台临时附件；只在回合唯一终态清理。 */
  attachments: MaterializedAttachments | null
  /** 出站发送链：串行化占位发送与每次 update，避免乱序/竞态。 */
  sendChain: Promise<void>
  /** 按账号能力判定，不能因 multiplexer 自身有 updateMessage 就误判所有平台。 */
  updateSupported: boolean
  timeoutTimer: NodeJS.Timeout | null
  finalizing: boolean
  finishPromise: Promise<void> | null
  /** sendTurn 返回的逻辑回合 id；新回合只接受同 id 事件。 */
  turnId: string | null
  /** sendTurn 返回前先到的事件暂存，等 turnId 确定后再筛选。 */
  turnIdResolved: boolean
  bufferedEvents: Array<{ event: AgentEvent; turnId?: string }>
  /**
   * 已被 Runtime 明确接受、但尚未到达唯一终态的 durable inbox entry。
   * 此阶段必须保持 dispatching；若主进程崩溃，重启后会转 recovery 并提示用户状态不确定。
   */
  inboxEntryId: string | null
}

interface QueuedChannelTurn {
  message: InboundChannelMessage
  binding: ChannelBinding
  prompt: string
  attachments: MaterializedAttachments | null
  /** durable inbox entry；存在时不能在仅进入内存队列后提前 completed。 */
  inboxEntryId?: string
}

const CHANNEL_PAIRING_TTL_MS = 60 * 60_000
const CHANNEL_PAIRING_MAX_PENDING = 3
const CHANNEL_PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function channelPairingCode(): string {
  const bytes = randomBytes(8)
  return [...bytes]
    .map((value) => CHANNEL_PAIRING_ALPHABET[value % CHANNEL_PAIRING_ALPHABET.length])
    .join('')
}

/** 单气泡流式节流：~300ms 更新一次（飞书 update ~5QPS，留余量），打字机感 + 不触限流。 */
const UPDATE_INTERVAL_MS = 300
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_QUEUED_CHANNEL_TURNS = 5
const QUEUED_TURN_START_RETRY_MS = 100
const QUEUED_TURN_START_RETRIES = 100

function turnIdFromResult(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('turnId' in result)) return null
  const value = (result as { turnId?: unknown }).turnId
  return typeof value === 'string' && value.trim() ? value : null
}

export class ChannelManager {
  private readonly render = new Map<string, RenderState>()
  private readonly queued = new Map<string, QueuedChannelTurn[]>()
  private started = false
  private stopping = false
  private scanController: AbortController | null = null
  private scanVerification: {
    resolve(code: string): void
    reject(error: Error): void
  } | null = null
  private inboxDrain: Promise<void> | null = null
  private inboxDrainRequested = false
  private inboxReady = true

  constructor(private readonly deps: ChannelManagerDeps) {}

  // ─── 生命周期 ──────────────────────────────────────────────────────────────

  /** 应用启动时调用：注册回调；若网关已开启则拉起已启用账号。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopping = false
    void cleanupStaleChannelAttachments().catch(() => {})
    this.deps.transport.onMessage((msg) => this.acceptInbound(msg))
    this.deps.transport.onStatus((accountId, status, error) =>
      this.onAccountStatus(accountId, status, error)
    )
    if (this.deps.inboundInbox) {
      try {
        this.deps.inboundInbox.recoverInterrupted()
      } catch (error) {
        this.inboxReady = false
        const message = error instanceof Error ? error.message : String(error)
        for (const account of getChannelAccounts().filter((item) => item.enabled)) {
          this.onAccountStatus(account.id, 'error', message)
        }
        return
      }
    }
    if (getChannelsGatewayEnabled()) {
      for (const account of getChannelAccounts()) {
        if (account.enabled) void this.startAccount(account).catch(() => {})
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.inboxDrain
    await this.clearAllQueuedTurns()
    await Promise.all(
      [...this.render.values()].map(async (state) => {
        await this.deps.interruptTurn(state.sessionId).catch(() => undefined)
        await this.finishState(state, tr('channels.message.gatewayStopped'), 'interrupted')
      })
    )
    for (const account of getChannelAccounts()) {
      await this.deps.transport.stop(account.id)
    }
  }

  private onAccountStatus(accountId: string, status: ChannelAccountStatus, error?: string): void {
    const accounts = getChannelAccounts()
    const idx = accounts.findIndex((a) => a.id === accountId)
    if (idx === -1) return
    const now = new Date().toISOString()
    accounts[idx] = {
      ...accounts[idx],
      status,
      error: status === 'error' ? error : undefined,
      health: {
        ...accounts[idx].health,
        ...(status === 'online' ? { transportConnectedAt: now } : {}),
        ...(status === 'error' ? { lastErrorAt: now } : {})
      }
    }
    setChannelAccounts(accounts)
    this.deps.emitAccountState(this.publicAccount(accounts[idx]))
    if (status === 'online') this.scheduleInboxDrain()
  }

  /** transport 同步拒绝或首次鉴权失败也必须进入可见 error，不能永久停在 connecting。 */
  private async startAccount(account: ChannelAccount): Promise<void> {
    try {
      await this.deps.transport.start(account)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.onAccountStatus(account.id, 'error', message)
      throw error
    }
  }

  // ─── 入站：消息 → 回合 ─────────────────────────────────────────────────────

  private async acceptInbound(msg: InboundChannelMessage): Promise<void> {
    if (!this.started || this.stopping || !getChannelsGatewayEnabled()) {
      throw new Error('消息网关未运行，已拒绝确认以等待平台重试')
    }
    if (!this.inboxReady) throw new Error('消息 inbox 不可用，已拒绝确认以等待平台重试')
    if (!this.deps.inboundInbox) return this.handleInbound(msg)
    try {
      this.deps.inboundInbox.enqueue(msg)
    } catch (error) {
      this.onAccountStatus(
        msg.accountId,
        'error',
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
    const account = getChannelAccounts().find((item) => item.id === msg.accountId)
    if (account && account.status !== 'online') this.onAccountStatus(msg.accountId, 'online')
    this.scheduleInboxDrain()
  }

  private scheduleInboxDrain(): void {
    if (!this.deps.inboundInbox || this.stopping || !this.inboxReady) return
    if (this.inboxDrain) {
      this.inboxDrainRequested = true
      return
    }
    this.inboxDrainRequested = false
    this.inboxDrain = Promise.resolve()
      .then(() => this.drainInbox())
      .catch((error: unknown) => {
        console.warn(
          `[channels] inbox drain failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        this.inboxDrain = null
        if (this.inboxDrainRequested) this.scheduleInboxDrain()
      })
  }

  private async drainInbox(): Promise<void> {
    const inbox = this.deps.inboundInbox
    if (!inbox) return
    while (this.started && !this.stopping && getChannelsGatewayEnabled()) {
      const accounts = getChannelAccounts()
      const onlineAccountIds = new Set(
        accounts.filter((item) => item.enabled && item.status === 'online').map((item) => item.id)
      )
      const deferredEntryIds = new Set(
        [...this.queued.values()].flatMap((queue) =>
          queue.flatMap((item) => (item.inboxEntryId ? [item.inboxEntryId] : []))
        )
      )
      const entry = inbox.next(
        (item) => onlineAccountIds.has(item.message.accountId) && !deferredEntryIds.has(item.id)
      )
      if (!entry) return
      try {
        await this.deps.transport.restoreInboundContext?.(entry.message)
      } catch (error) {
        this.onAccountStatus(
          entry.message.accountId,
          'error',
          `消息恢复上下文失败：${error instanceof Error ? error.message : String(error)}`
        )
        continue
      }
      if (entry.status === 'recovery') {
        if (!(await this.notifyUncertainDelivery(entry))) {
          this.onAccountStatus(
            entry.message.accountId,
            'error',
            '消息恢复通知发送失败，请重新连接后重试'
          )
          continue
        }
        try {
          inbox.markCompleted(entry.id)
        } catch (error) {
          this.onAccountStatus(
            entry.message.accountId,
            'error',
            `消息 inbox 完成状态落盘失败：${error instanceof Error ? error.message : String(error)}`
          )
          continue
        }
        continue
      }
      try {
        inbox.markDispatching(entry.id)
      } catch (error) {
        this.onAccountStatus(
          entry.message.accountId,
          'error',
          `消息 inbox 派发状态落盘失败：${error instanceof Error ? error.message : String(error)}`
        )
        continue
      }
      try {
        await this.handleInbound(entry.message, entry.id)
      } catch (error) {
        try {
          inbox.markRecovery(entry.id)
        } catch {
          /* 重启时会把磁盘上的 dispatching 转 recovery */
        }
        this.onAccountStatus(
          entry.message.accountId,
          'error',
          `消息处理状态不确定：${error instanceof Error ? error.message : String(error)}`
        )
        continue
      }
      // 活跃会话只把 entry 退回 durable queued，并在真正启动排队回合时完成；
      // 不能因进入易失内存队列就提前 completed。
      if (
        inbox.snapshot().entries.some((item) => item.id === entry.id && item.status === 'queued')
      ) {
        continue
      }
      // Runtime 已接受的活跃回合必须一直保留 dispatching，直到成功/失败/取消/超时终态。
      // 否则主进程在 Agent 执行中崩溃时，重启既不会重放，也不会给用户可见的 recovery 通知。
      if ([...this.render.values()].some((state) => state.inboxEntryId === entry.id)) {
        continue
      }
      try {
        inbox.markCompleted(entry.id)
      } catch (error) {
        try {
          inbox.markRecovery(entry.id)
        } catch {
          /* 保留 dispatching，重启后进入 recovery */
        }
        this.onAccountStatus(
          entry.message.accountId,
          'error',
          `消息 inbox 完成状态落盘失败：${error instanceof Error ? error.message : String(error)}`
        )
        continue
      }
    }
  }

  private async notifyUncertainDelivery(entry: ChannelInboxEntry): Promise<boolean> {
    try {
      await this.deps.transport.send({
        accountId: entry.message.accountId,
        chatType: entry.message.chatType,
        chatId: entry.message.chatId,
        segments: [
          {
            type: 'text',
            data: { text: tr('channels.message.inboundRecovery') }
          }
        ]
      })
      this.updateAccountHealth(entry.message.accountId, {
        lastOutboundAt: new Date().toISOString()
      })
      return true
    } catch {
      this.updateAccountHealth(entry.message.accountId, { lastErrorAt: new Date().toISOString() })
      return false
    }
  }

  private async handleInbound(msg: InboundChannelMessage, inboxEntryId?: string): Promise<void> {
    if (!getChannelsGatewayEnabled()) return
    const account = getChannelAccounts().find((a) => a.id === msg.accountId)
    if (!account) return
    this.updateAccountHealth(msg.accountId, { lastInboundAt: new Date().toISOString() })
    // owner 未设置时必须由桌面端显式批准 pairing；任何“第一位私聊者自动认领”都会
    // 让公开机器人暴露抢占本机 agent 的窗口。群聊始终不能发起 owner pairing。
    const acls = getChannelAcls()
    const acl = acls[msg.accountId]
    if (acl?.mode === 'owner' && !acl.ownerId && msg.chatType === 'private') {
      const request = this.createOrReusePairingRequest(msg)
      await this.reply(msg, [
        {
          type: 'text',
          data: {
            text: request
              ? tr('channels.message.pairingRequired', { code: request.code, userId: msg.userId })
              : tr('channels.message.pairingQueueFull')
          }
        }
      ])
      return
    }
    if (!isAllowed(acl, msg.userId)) {
      // 私聊不能让未授权用户只看到“机器人没反应”；返回请求者 ID，便于转给管理员加入白名单。
      // 群聊仍静默拒绝，避免机器人在未授权群内制造噪音或泄露策略细节。
      if (msg.chatType === 'private') {
        await this.reply(msg, [
          {
            type: 'text',
            data: { text: tr('channels.message.accessDenied', { userId: msg.userId }) }
          }
        ])
      }
      return
    }
    // 群聊仅在被 @ 时响应；私聊恒响应
    if (msg.chatType === 'group' && !msg.mentioned) return

    const cmd = parseCommand(msg.text)
    if (cmd?.cmd === 'help') return this.handleHelp(msg)
    if (cmd?.cmd === 'unknown') {
      return this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.unknownCommand', { command: cmd.arg }) }
        }
      ])
    }
    if (cmd?.cmd === 'stop') return this.handleStop(msg)
    if (cmd?.cmd === 'agents') return this.handleAgentsList(msg)
    if (cmd?.cmd === 'use') return this.handleUse(msg, cmd.arg)
    if (cmd?.cmd === 'new') return this.handleNew(msg)
    if (cmd?.cmd === 'status') return this.handleStatus(msg)
    if (cmd?.cmd === 'sessions') return this.handleSessions(msg)
    if (cmd?.cmd === 'session') return this.handleSessionSwitch(msg, cmd.arg)
    if (cmd?.cmd === 'tasks') return this.handleTasks(msg)
    if (cmd?.cmd === 'task') return this.handleTaskCommand(msg, cmd.arg)
    if (cmd?.cmd === 'steer') return this.handleSteer(msg, cmd.arg)
    if (cmd?.cmd === 'cd') {
      return this.reply(msg, [
        { type: 'text', data: { text: tr('channels.message.cdDesktopOnly') } }
      ])
    }
    if (cmd?.cmd === 'open') {
      const binding = findBinding(this.routerDeps(), msg)
      const link = binding
        ? `${this.deps.deepLinkBase}/${binding.conversationId}`
        : this.deps.deepLinkBase
      return this.reply(msg, [{ type: 'text', data: { text: `🔗 ${link}` } }])
    }

    // 首次接入：尚无绑定时落库后会发一次欢迎语（带动态 agent 列表）。
    const isFirstTime = !findBinding(this.routerDeps(), msg)
    let binding: ChannelBinding
    try {
      binding = await resolveBinding(this.routerDeps(), msg)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      return this.reply(msg, [{ type: 'text', data: { text: `⚠️ ${text}` } }])
    }
    if (isFirstTime) {
      await this.sendWelcome(msg, binding.toolId)
    }

    const textPrompt = msg.text.trim()
    const hasAttachmentSegments = msg.segments.some(
      (segment) =>
        segment.type === 'image' ||
        segment.type === 'file' ||
        segment.type === 'voice' ||
        segment.type === 'video'
    )
    // 首条消息常是打招呼，没实质内容也没附件时只发欢迎语、不开回合。
    if (!textPrompt && !hasAttachmentSegments) return

    // 只在 Runtime 证明会端到端传递逻辑 turnId 时排队。旧节点/未解析回合继续安全拒绝，
    // 否则迟到的旧事件会被写进下一条 IM 气泡。
    let activeState = this.render.get(binding.conversationId)
    if (activeState && (!activeState.turnIdResolved || !activeState.turnId)) {
      return this.reply(msg, [
        { type: 'text', data: { text: tr('channels.message.turnInProgress') } }
      ])
    }
    if (
      activeState &&
      (this.queued.get(binding.conversationId)?.length ?? 0) >= MAX_QUEUED_CHANNEL_TURNS
    ) {
      return this.reply(msg, [{ type: 'text', data: { text: tr('channels.message.queueFull') } }])
    }

    let attachments: MaterializedAttachments | null = null
    if (hasAttachmentSegments) {
      if (!this.deps.transport.materializeInboundAttachments) {
        return this.reply(msg, [
          { type: 'text', data: { text: tr('channels.message.attachmentsUnsupported') } }
        ])
      }
      try {
        attachments = await this.deps.transport.materializeInboundAttachments(msg)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.updateAccountHealth(msg.accountId, { lastErrorAt: new Date().toISOString() })
        return this.reply(msg, [
          {
            type: 'text',
            data: { text: tr('channels.message.attachmentDownloadFailed', { message }) }
          }
        ])
      }
      if (!attachments?.files.length) {
        return this.reply(msg, [
          { type: 'text', data: { text: tr('channels.message.attachmentsUnsupported') } }
        ])
      }
    }

    // 附件下载可能持续较久；期间旧回合可能结束，甚至下一回合已经启动。
    // 必须重新读取实时状态，不能用下载前的 stale activeState 把 durable entry 永久塞进无人唤醒的队列。
    activeState = this.render.get(binding.conversationId)
    if (activeState && (!activeState.turnIdResolved || !activeState.turnId)) {
      await attachments?.cleanup().catch(() => {})
      return this.reply(msg, [
        { type: 'text', data: { text: tr('channels.message.turnInProgress') } }
      ])
    }

    const prompt =
      textPrompt ||
      tr('channels.message.attachmentPrompt', { count: attachments?.files.length ?? 0 })

    if (activeState) {
      const queue = this.queued.get(binding.conversationId) ?? []
      // 附件下载期间可能又有消息入队，入队前必须二次检查上限。
      if (queue.length >= MAX_QUEUED_CHANNEL_TURNS) {
        await attachments?.cleanup().catch(() => {})
        return this.reply(msg, [{ type: 'text', data: { text: tr('channels.message.queueFull') } }])
      }
      if (inboxEntryId && this.deps.inboundInbox) {
        this.deps.inboundInbox.markQueued(inboxEntryId)
      }
      queue.push({ message: msg, binding, prompt, attachments, inboxEntryId })
      this.queued.set(binding.conversationId, queue)
      try {
        return await this.reply(msg, [
          {
            type: 'text',
            data: { text: tr('channels.message.queued', { position: queue.length }) }
          }
        ])
      } catch (error) {
        const index = queue.findIndex(
          (item) => item.inboxEntryId === inboxEntryId && item.message === msg
        )
        if (index >= 0) queue.splice(index, 1)
        if (!queue.length) this.queued.delete(binding.conversationId)
        await attachments?.cleanup().catch(() => {})
        if (inboxEntryId && this.deps.inboundInbox) {
          this.deps.inboundInbox.markDispatching(inboxEntryId)
        }
        throw error
      }
    }

    const accepted = await this.startChannelTurn(
      msg,
      binding,
      prompt,
      attachments,
      false,
      inboxEntryId
    )
    if (!accepted && inboxEntryId) {
      throw new Error('Agent 回合未确认启动，保留消息恢复状态')
    }
  }

  private async startChannelTurn(
    msg: InboundChannelMessage,
    binding: ChannelBinding,
    prompt: string,
    attachments: MaterializedAttachments | null,
    requireTurnId = false,
    inboxEntryId?: string,
    mode: 'send' | 'steer' = 'send'
  ): Promise<boolean> {
    const previousState = this.render.get(binding.conversationId)
    // 记录渲染态：回合事件据此回灌到单条可变消息。
    const state: RenderState = {
      sessionId: binding.conversationId,
      accountId: msg.accountId,
      chatType: msg.chatType,
      chatId: msg.chatId,
      pending: '',
      committed: '',
      messageId: null,
      flushTimer: null,
      sentAny: false,
      terminalDelivered: false,
      attachments,
      sendChain: Promise.resolve(),
      updateSupported: this.canUpdate(msg.accountId),
      timeoutTimer: null,
      finalizing: false,
      finishPromise: null,
      turnId: null,
      turnIdResolved: false,
      bufferedEvents: [],
      inboxEntryId: null
    }
    this.render.set(binding.conversationId, state)
    if (mode === 'steer' && previousState) {
      await this.finishState(previousState, tr('channels.message.steering'), 'interrupted')
    }
    // 单气泡流式（Hermes 式）：回合一开始发一条占位文本"思考中…"并记下 messageId，
    // 后续 text-delta/tool/turn-end 用 update 流式覆盖同一条消息（默认文本样式，非卡片）。
    // 平台不支持 updateMessage 时，上层自动降级（见 handleAgentEvent 的多文本分支）。
    state.timeoutTimer = setTimeout(() => {
      void this.timeoutTurn(state)
    }, DEFAULT_TURN_TIMEOUT_MS)
    state.timeoutTimer.unref?.()
    await this.sendPlaceholder(state, tr('channels.message.thinking'))
    try {
      const result =
        mode === 'steer'
          ? await this.deps.steerTurn(binding.conversationId, prompt, attachments?.files)
          : await this.sendTurnWithQueueRetry(
              binding.conversationId,
              prompt,
              attachments?.files,
              requireTurnId
            )
      if (this.render.get(binding.conversationId) === state && !state.turnIdResolved) {
        state.turnId = turnIdFromResult(result)
        state.turnIdResolved = true
        if (requireTurnId && !state.turnId) {
          state.bufferedEvents = []
          await this.clearQueuedTurns(binding.conversationId)
          await this.finishState(state, tr('channels.message.turnIdUnavailable'), 'error')
          return false
        }
        // 只有 Runtime 已接受回合（排队回合还必须具备 turnId）后才关联 durable entry。
        // 同步拒绝继续由调用方置 recovery，不能被终态清理误标 completed。
        state.inboxEntryId = inboxEntryId ?? null
        const buffered = state.bufferedEvents.splice(0)
        for (const item of buffered) this.handleAgentEvent(state.sessionId, item.event, item.turnId)
      }
      return true
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      await this.finishState(state, tr('channels.message.busyTurn', { message: text }), 'error')
      return false
    }
  }

  private async sendTurnWithQueueRetry(
    sessionId: string,
    prompt: string,
    files: string[] | undefined,
    queuedTurn: boolean
  ): Promise<unknown> {
    for (let attempt = 0; attempt < QUEUED_TURN_START_RETRIES; attempt += 1) {
      try {
        return await this.deps.sendTurn(sessionId, prompt, files)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const oldTurnStillExiting = message.includes(tr('chat.error.turnInProgress'))
        if (!queuedTurn || !oldTurnStillExiting || attempt === QUEUED_TURN_START_RETRIES - 1)
          throw error
        await new Promise((resolve) => setTimeout(resolve, QUEUED_TURN_START_RETRY_MS))
      }
    }
    throw new Error(tr('chat.error.turnInProgress'))
  }

  private canUpdate(accountId: string): boolean {
    return (
      this.deps.transport.canUpdate?.(accountId) ??
      typeof this.deps.transport.updateMessage === 'function'
    )
  }

  /** 发占位消息（单气泡流式的锚点），记下 messageId；失败则后续自动降级为多文本。 */
  private async sendPlaceholder(state: RenderState, text: string): Promise<void> {
    if (!state.updateSupported) return
    state.sendChain = state.sendChain
      .catch(() => {})
      .then(() =>
        this.deps.transport.send!({
          accountId: state.accountId,
          chatType: state.chatType,
          chatId: state.chatId,
          segments: [{ type: 'text', data: { text } }],
          streaming: true
        }).then(
          ({ messageId }) => {
            if (messageId) state.messageId = messageId
            this.updateAccountHealth(state.accountId, { lastOutboundAt: new Date().toISOString() })
          },
          (err) => {
            const t = err instanceof Error ? err.message : String(err)
            console.warn(`[channels] send placeholder failed: ${t}`)
          }
        )
      )
    await state.sendChain
  }

  private async handleStop(msg: InboundChannelMessage): Promise<void> {
    const binding = findBinding(this.routerDeps(), msg)
    if (!binding)
      return this.reply(msg, [
        { type: 'text', data: { text: tr('channels.message.noActiveTurn') } }
      ])
    const cancelled = await this.clearQueuedTurns(binding.conversationId)
    const state = this.render.get(binding.conversationId)
    const interrupted = await this.deps.interruptTurn(binding.conversationId)
    if (state) await this.finishState(state, tr('channels.message.interrupted'), 'interrupted')
    if (!interrupted && !state && cancelled === 0) {
      return this.reply(msg, [
        { type: 'text', data: { text: tr('channels.message.noActiveTurn') } }
      ])
    }
    if (cancelled > 0) {
      await this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.queueCancelled', { count: cancelled }) }
        }
      ])
    }
  }

  private async handleAgentsList(msg: InboundChannelMessage): Promise<void> {
    const agents = await this.deps.listAgents()
    if (!agents.length)
      return this.reply(msg, [
        { type: 'text', data: { text: tr('channels.message.noAgentConfig') } }
      ])
    const current = findBinding(this.routerDeps(), msg)?.toolId
    const text = this.buildAgentListText(agents, current)
    await this.reply(msg, [{ type: 'text', data: { text } }])
  }

  private async handleHelp(msg: InboundChannelMessage): Promise<void> {
    await this.reply(msg, [{ type: 'text', data: { text: tr('channels.message.helpBody') } }])
  }

  private async handleStatus(msg: InboundChannelMessage): Promise<void> {
    const binding = findBinding(this.routerDeps(), msg)
    const account = getChannelAccounts().find((item) => item.id === msg.accountId)
    const health = account?.health
    const lines = [
      `Transport: ${account?.status ?? 'disconnected'}`,
      `Agent: ${binding?.toolId ?? '-'}`,
      `Session: ${binding?.conversationId ?? '-'}`,
      `Turn: ${binding && this.hasActiveTurn(binding.conversationId) ? 'running' : 'idle'}`,
      `Queue: ${binding ? (this.queued.get(binding.conversationId)?.length ?? 0) : 0}`,
      `Last inbound: ${health?.lastInboundAt ?? '-'}`,
      `Last completed: ${health?.lastTurnCompletedAt ?? '-'}`
    ]
    await this.reply(msg, [{ type: 'text', data: { text: lines.join('\n') } }])
  }

  /** 组装动态 agent 列表（/agents 与欢迎语共用；agent 来自实时发现，非写死）。 */
  private buildAgentListText(agents: { toolId: string; name: string }[], current?: string): string {
    const lines = agents.map(
      (a) => `${a.toolId === current ? '▶ ' : '  '}${a.name}  /use ${a.toolId}`
    )
    return [
      tr('channels.message.agentsListTitle'),
      ...lines,
      '',
      tr('channels.message.currentAgent', { name: current ?? tr('channels.message.notBound') }),
      tr('channels.message.switchHint')
    ].join('\n')
  }

  /** 首次接入欢迎语：个性化称呼 + 动态 agent 列表。名称取不到时用兜底称呼。 */
  private async sendWelcome(msg: InboundChannelMessage, currentToolId: string): Promise<void> {
    const agents = await this.deps.listAgents()
    let name = msg.userName?.trim() || ''
    if (!name && this.deps.transport.getUserDisplayName) {
      name = (await this.deps.transport.getUserDisplayName(msg.accountId, msg.userId)) ?? ''
    }
    const greeting = name
      ? tr('channels.message.welcomeNamed', { name })
      : tr('channels.message.welcome')
    const list = this.buildAgentListText(agents, currentToolId)
    const text = `${greeting}\n${tr('channels.message.welcomeReady')}\n\n${list}`
    await this.reply(msg, [{ type: 'text', data: { text } }])
  }

  private async handleUse(msg: InboundChannelMessage, arg: string): Promise<void> {
    if (!arg) return this.handleAgentsList(msg)
    const agents = await this.deps.listAgents()
    const agent = agents.find(
      (a) =>
        a.toolId.toLowerCase() === arg.toLowerCase() || a.name.toLowerCase() === arg.toLowerCase()
    )
    if (!agent) {
      const names =
        agents.map((a) => a.toolId).join(tr('channels.message.listSeparator')) ||
        tr('channels.message.noneAvailable')
      return this.reply(msg, [
        { type: 'text', data: { text: tr('channels.message.useNotFound', { arg, names }) } }
      ])
    }
    const existing = findBinding(this.routerDeps(), msg)
    if (existing?.toolId === agent.toolId) {
      return this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.alreadyCurrent', { name: agent.name }) }
        }
      ])
    }
    const sessions = existing?.sessions ?? {}
    let sessionId = sessions[agent.toolId]
    if (!sessionId) {
      const session = await this.deps.createChannelSession({
        name: `${this.platformLabel(msg.platform)} ${msg.chatType === 'private' ? '私聊' : '群聊'}`,
        toolId: agent.toolId,
        workspacePath: existing?.workspacePath ?? agent.workspacePath,
        channelBinding: {
          platform: msg.platform,
          accountId: msg.accountId,
          chatType: msg.chatType,
          chatId: msg.chatId
        }
      })
      sessionId = session.id
    }
    const binding: ChannelBinding = {
      platform: msg.platform as ChannelBinding['platform'],
      accountId: msg.accountId,
      chatType: msg.chatType as ChannelBinding['chatType'],
      chatId: msg.chatId,
      conversationId: sessionId,
      toolId: agent.toolId,
      workspacePath: existing?.workspacePath ?? agent.workspacePath,
      sessions: { ...sessions, [agent.toolId]: sessionId }
    }
    this.routerDeps().saveBinding(binding)
    await this.reply(msg, [
      { type: 'text', data: { text: tr('channels.message.switchedTo', { name: agent.name }) } }
    ])
  }

  private async handleNew(msg: InboundChannelMessage): Promise<void> {
    const existing = findBinding(this.routerDeps(), msg)
    const defaultAgent = await this.deps.pickDefaultAgent()
    const toolId = existing?.toolId ?? defaultAgent?.toolId
    const workspacePath = existing?.workspacePath ?? defaultAgent?.workspacePath
    if (!toolId || !workspacePath) {
      return this.reply(msg, [
        { type: 'text', data: { text: tr('channels.message.noAgentForNew') } }
      ])
    }
    const session = await this.deps.createChannelSession({
      name: `${this.platformLabel(msg.platform)} ${msg.chatType === 'private' ? '私聊' : '群聊'}`,
      toolId,
      workspacePath,
      channelBinding: {
        platform: msg.platform,
        accountId: msg.accountId,
        chatType: msg.chatType,
        chatId: msg.chatId
      }
    })
    const sessions = { ...(existing?.sessions ?? {}), [toolId]: session.id }
    const binding: ChannelBinding = {
      platform: msg.platform as ChannelBinding['platform'],
      accountId: msg.accountId,
      chatType: msg.chatType as ChannelBinding['chatType'],
      chatId: msg.chatId,
      conversationId: session.id,
      toolId,
      workspacePath,
      sessions
    }
    this.routerDeps().saveBinding(binding)
    const agents = await this.deps.listAgents()
    const agentName = agents.find((a) => a.toolId === toolId)?.name ?? toolId
    await this.reply(msg, [
      {
        type: 'text',
        data: { text: tr('channels.message.newConversation', { name: agentName, toolId }) }
      }
    ])
  }

  private async channelSessions(
    msg: InboundChannelMessage,
    binding: ChannelBinding
  ): Promise<WorkbenchSession[]> {
    const knownIds = new Set([binding.conversationId, ...Object.values(binding.sessions ?? {})])
    return (await this.deps.listSessions())
      .filter((session) => {
        if (session.surface !== 'chat') return false
        if (knownIds.has(session.id)) return true
        const channel = session.channelBinding
        return (
          session.source === 'channel' &&
          channel?.platform === msg.platform &&
          channel.accountId === msg.accountId &&
          channel.chatType === msg.chatType &&
          channel.chatId === msg.chatId
        )
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20)
  }

  private resolveReference<T extends { id: string }>(
    items: T[],
    raw: string
  ): { item?: T; error?: string } {
    const ref = raw.trim()
    if (!ref) return { error: tr('channels.message.referenceRequired') }
    if (/^\d+$/.test(ref)) {
      const item = items[Number(ref) - 1]
      return item ? { item } : { error: tr('channels.message.referenceNotFound', { ref }) }
    }
    const matches = items.filter((item) => item.id === ref || item.id.startsWith(ref))
    if (matches.length === 1) return { item: matches[0] }
    if (matches.length > 1) return { error: tr('channels.message.referenceAmbiguous', { ref }) }
    return { error: tr('channels.message.referenceNotFound', { ref }) }
  }

  private async handleSessions(msg: InboundChannelMessage): Promise<void> {
    const binding = findBinding(this.routerDeps(), msg)
    if (!binding) {
      return this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.noBoundSession') }
        }
      ])
    }
    const sessions = await this.channelSessions(msg, binding)
    const lines = sessions.map(
      (session, index) =>
        `${index + 1}. ${session.id === binding.conversationId ? '▶ ' : ''}${session.name} · ${session.toolId} · ${session.id.slice(0, 8)}`
    )
    await this.reply(msg, [
      {
        type: 'text',
        data: {
          text: [
            tr('channels.message.sessionsTitle'),
            ...(lines.length ? lines : [tr('channels.message.noSessions')]),
            '',
            tr('channels.message.sessionSwitchHint')
          ].join('\n')
        }
      }
    ])
  }

  private async handleSessionSwitch(msg: InboundChannelMessage, arg: string): Promise<void> {
    const binding = findBinding(this.routerDeps(), msg)
    if (!binding) return this.handleSessions(msg)
    const sessions = await this.channelSessions(msg, binding)
    const resolved = this.resolveReference(sessions, arg)
    if (!resolved.item) {
      return this.reply(msg, [{ type: 'text', data: { text: `⚠️ ${resolved.error}` } }])
    }
    if (this.render.has(binding.conversationId)) {
      return this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.switchWhileRunning') }
        }
      ])
    }
    const session = resolved.item
    this.routerDeps().saveBinding({
      ...binding,
      conversationId: session.id,
      toolId: session.toolId,
      workspacePath: session.workspacePath,
      sessions: { ...(binding.sessions ?? {}), [session.toolId]: session.id }
    })
    await this.reply(msg, [
      {
        type: 'text',
        data: { text: tr('channels.message.sessionSwitched', { name: session.name }) }
      }
    ])
  }

  private async channelTasks(msg: InboundChannelMessage): Promise<{
    binding: ChannelBinding | null
    session: WorkbenchSession | null
    tasks: AgentTask[]
  }> {
    const binding = findBinding(this.routerDeps(), msg) ?? null
    const session = binding ? this.deps.getSession(binding.conversationId) : null
    if (!binding || !session) return { binding, session, tasks: [] }
    const hostId = session.runtimeHostId ?? 'local'
    const tasks = (await this.deps.listTasks())
      .filter(
        (task) =>
          task.workspacePath === session.workspacePath && (task.runtimeHostId ?? 'local') === hostId
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 30)
    return { binding, session, tasks }
  }

  private taskScheduleText(task: AgentTask): string {
    const schedule = task.schedule
    if (!schedule) return tr('channels.message.taskManual')
    if (!schedule.enabled) return tr('channels.message.taskPaused')
    if (schedule.kind === 'once') return `${tr('channels.message.taskOnce')} ${schedule.runAt}`
    if (schedule.kind === 'interval') {
      const hours = schedule.everyMs / 3_600_000
      return Number.isInteger(hours)
        ? tr('channels.message.taskEveryHours', { count: hours })
        : tr('channels.message.taskEveryMinutes', { count: schedule.everyMs / 60_000 })
    }
    return `Cron ${schedule.expression}`
  }

  private async handleTasks(msg: InboundChannelMessage): Promise<void> {
    const { session, tasks } = await this.channelTasks(msg)
    if (!session) {
      return this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.noBoundSession') }
        }
      ])
    }
    const lines = tasks.map(
      (task, index) =>
        `${index + 1}. ${task.title} · ${this.taskScheduleText(task)} · ${task.executionStatus} · ${task.id.slice(0, 8)}`
    )
    await this.reply(msg, [
      {
        type: 'text',
        data: {
          text: [
            tr('channels.message.tasksTitle', { workspace: session.workspacePath }),
            ...(lines.length ? lines : [tr('channels.message.noTasks')]),
            '',
            tr('channels.message.taskCommandHint')
          ].join('\n')
        }
      }
    ])
  }

  private async handleTaskCommand(msg: InboundChannelMessage, arg: string): Promise<void> {
    const trimmed = arg.trim()
    const action = trimmed.split(/\s+/, 1)[0]?.toLowerCase()
    const rest = trimmed.slice(action?.length ?? 0).trim()
    const { session, tasks } = await this.channelTasks(msg)
    if (!session) {
      return this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.noBoundSession') }
        }
      ])
    }
    if (action === 'add') {
      const intent = parseSemanticTaskIntent(`创建任务 ${rest}`)
      if (!intent) {
        return this.reply(msg, [
          {
            type: 'text',
            data: { text: tr('channels.message.taskAddInvalid') }
          }
        ])
      }
      const task = await this.deps.createTask({
        title: intent.title,
        prompt: intent.prompt,
        workspacePath: session.workspacePath,
        ...(session.runtimeHostId ? { runtimeHostId: session.runtimeHostId } : {}),
        assignee: {
          toolId: session.toolId,
          ...(session.model ? { model: session.model } : {})
        },
        boardStatus: 'todo',
        permissionPreset: session.permissionPreset ?? 'safe',
        sessionPolicy: 'new',
        creationSource: 'semantic',
        schedule: intent.schedule
      })
      return this.reply(msg, [
        {
          type: 'text',
          data: {
            text: tr('channels.message.taskCreated', {
              title: task.title,
              schedule: this.taskScheduleText(task)
            })
          }
        }
      ])
    }

    const ref = rest.split(/\s+/, 1)[0] ?? ''
    const resolved = this.resolveReference(tasks, ref)
    if (!resolved.item) {
      return this.reply(msg, [
        {
          type: 'text',
          data: {
            text:
              action === 'show' ||
              action === 'edit' ||
              action === 'pause' ||
              action === 'resume' ||
              action === 'delete'
                ? `⚠️ ${resolved.error}`
                : tr('channels.message.taskCommandHint')
          }
        }
      ])
    }
    const task = resolved.item
    if (action === 'show') {
      return this.reply(msg, [
        {
          type: 'text',
          data: {
            text: [
              `📌 ${task.title}`,
              `${tr('channels.message.taskScheduleLabel')}: ${this.taskScheduleText(task)}`,
              `${tr('channels.message.taskAgentLabel')}: ${task.assignee.toolId}`,
              `${tr('channels.message.taskStatusLabel')}: ${task.executionStatus}`,
              '',
              task.prompt
            ].join('\n')
          }
        }
      ])
    }
    if (action === 'edit') {
      const editText = rest.slice(ref.length).trim()
      const intent = parseSemanticTaskIntent(`创建任务 ${editText}`)
      if (!intent) {
        return this.reply(msg, [
          {
            type: 'text',
            data: { text: tr('channels.message.taskEditInvalid') }
          }
        ])
      }
      const updated = await this.deps.updateTask(task.id, {
        title: intent.title,
        prompt: intent.prompt,
        schedule: intent.schedule
      })
      return this.reply(msg, [
        {
          type: 'text',
          data: {
            text: tr('channels.message.taskUpdated', { title: updated?.title ?? task.title })
          }
        }
      ])
    }
    if (action === 'pause' || action === 'resume') {
      if (!task.schedule) {
        return this.reply(msg, [
          {
            type: 'text',
            data: { text: tr('channels.message.taskNoSchedule') }
          }
        ])
      }
      const updated = await this.deps.updateTask(task.id, {
        schedule: { ...task.schedule, enabled: action === 'resume' }
      })
      return this.reply(msg, [
        {
          type: 'text',
          data: {
            text:
              action === 'resume'
                ? tr('channels.message.taskResumed', { title: updated?.title ?? task.title })
                : tr('channels.message.taskPausedDone', { title: updated?.title ?? task.title })
          }
        }
      ])
    }
    if (action === 'delete') {
      const confirmed = /\sconfirm$/i.test(rest)
      if (!confirmed) {
        return this.reply(msg, [
          {
            type: 'text',
            data: {
              text: tr('channels.message.taskDeleteConfirm', {
                ref,
                title: task.title
              })
            }
          }
        ])
      }
      await this.deps.removeTask(task.id)
      return this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.taskDeleted', { title: task.title }) }
        }
      ])
    }
    return this.reply(msg, [
      {
        type: 'text',
        data: { text: tr('channels.message.taskCommandHint') }
      }
    ])
  }

  private async handleSteer(msg: InboundChannelMessage, arg: string): Promise<void> {
    const prompt = arg.trim()
    if (!prompt) {
      return this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.steerUsage') }
        }
      ])
    }
    const binding = findBinding(this.routerDeps(), msg)
    if (!binding) {
      return this.reply(msg, [
        {
          type: 'text',
          data: { text: tr('channels.message.noBoundSession') }
        }
      ])
    }
    await this.startChannelTurn(msg, binding, prompt, null, false, undefined, 'steer')
  }

  // ─── 出站：AgentEvent → 渠道（经 index.ts emit 分流注入）──────────────────

  /** 该会话是否正有一个渠道回合在进行（事件路由用，兼容 source 字段缺失的旧会话）。 */
  hasActiveTurn(sessionId: string): boolean {
    return this.render.has(sessionId)
  }

  handleAgentEvent(sessionId: string, event: AgentEvent, eventTurnId?: string): void {
    const state = this.render.get(sessionId)
    if (!state) return // 非渠道会话或回合已结束/清理
    if (state.finalizing) return // 终态发送已开始，迟到事件不得再改写当前气泡
    if (!state.turnIdResolved) {
      state.bufferedEvents.push({ event, ...(eventTurnId ? { turnId: eventTurnId } : {}) })
      return
    }
    // 有 turnId 契约时，无 id 或旧 id 事件都不得污染当前气泡。
    if (state.turnId && eventTurnId !== state.turnId) return
    this.applyAgentEvent(state, event)
  }

  private applyAgentEvent(state: RenderState, event: AgentEvent): void {
    if (event.kind === 'text-delta') {
      state.pending += event.text
      // 节流更新单条消息（攒 ~300ms 再 update，避免打爆 5QPS 限流）。
      if (state.updateSupported) this.scheduleUpdate(state)
      return
    }
    if (event.kind === 'tool-start') {
      // 工具边界：把工具前的正文并入，再追加一行进度，立即更新。
      this.appendLine(state, toolProgressLine(event.toolName, event.input))
      return
    }
    if (event.kind === 'turn-end') {
      if (event.status === 'completed') {
        void this.finishState(state, undefined, 'completed')
      } else {
        void this.finishState(state, tr('channels.message.interrupted'), 'interrupted')
      }
      return
    }
    if (event.kind === 'error') {
      if (event.retryable) {
        // Claude API 暂时断开，正在自动重试；占位消息仍在，等 turn-end 再收尾。不刷消息避免噪音。
        return
      }
      void this.finishState(
        state,
        tr('channels.message.error', { message: event.message }),
        'error'
      )
    }
  }

  /** 起/续节流定时器：到点把 pending 并入 committed 并 update 单条消息。 */
  private scheduleUpdate(state: RenderState): void {
    if (state.flushTimer) return
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null
      this.publish(state, false)
    }, UPDATE_INTERVAL_MS)
    state.flushTimer.unref?.()
  }

  private clearFlush(state: RenderState): void {
    if (!state.flushTimer) return
    clearTimeout(state.flushTimer)
    state.flushTimer = null
  }

  /** pending 原样并入 committed。流式 delta 可能从空格处切分，不能 trim 或强插段落。 */
  private commitPending(state: RenderState): void {
    const delta = state.pending
    state.pending = ''
    if (!delta) return
    state.committed += delta
    if (delta.trim()) state.sentAny = true
  }

  /** 追加一行（工具进度/中断/错误），并入 committed 后立即更新。 */
  private appendLine(state: RenderState, line: string): void {
    this.commitPending(state)
    const prefix = state.committed.trimEnd()
    state.committed = prefix ? `${prefix}\n\n${line}` : line
    state.sentAny = true
    this.publish(state, false)
  }

  private finishState(
    state: RenderState,
    terminalText: string | undefined,
    outcome: 'completed' | 'interrupted' | 'error'
  ): Promise<void> {
    if (state.finishPromise) return state.finishPromise
    state.finalizing = true
    state.finishPromise = this.performFinishState(state, terminalText, outcome)
    return state.finishPromise
  }

  private async timeoutTurn(state: RenderState): Promise<void> {
    // 先锁定“超时”这个唯一终态，再中断底层 runtime；同步回送的 interrupted 事件会被 finalizing 闸门忽略。
    const finishing = this.finishState(state, tr('channels.message.timeout'), 'error')
    await this.deps.interruptTurn(state.sessionId).catch(() => undefined)
    await finishing
  }

  private async performFinishState(
    state: RenderState,
    terminalText: string | undefined,
    outcome: 'completed' | 'interrupted' | 'error'
  ): Promise<void> {
    this.clearFlush(state)
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer)
      state.timeoutTimer = null
    }
    this.commitPending(state)
    if (terminalText) {
      state.committed = [state.committed, terminalText].filter((part) => part.trim()).join('\n\n')
    }
    if (!state.committed.trim()) state.committed = tr('channels.message.completed')
    this.publish(state, true)
    await state.sendChain.catch(() => {})
    if (state.attachments) {
      const current = state.attachments
      state.attachments = null
      await current.cleanup().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[channels] attachment cleanup failed: ${message}`)
      })
    }
    if (state.inboxEntryId && this.deps.inboundInbox) {
      try {
        this.deps.inboundInbox.markCompleted(state.inboxEntryId)
      } catch (error) {
        // 保留磁盘上的 dispatching；下次启动进入 recovery，不能把落盘失败误报为已收口。
        console.warn(
          `[channels] inbox terminal completion failed: ${error instanceof Error ? error.message : String(error)}`
        )
        state.terminalDelivered = false
      }
    }
    if (this.render.get(state.sessionId) === state) this.render.delete(state.sessionId)
    const now = new Date().toISOString()
    this.updateAccountHealth(
      state.accountId,
      outcome === 'completed' && state.terminalDelivered
        ? { lastTurnCompletedAt: now }
        : { lastErrorAt: now }
    )
    if (!this.stopping) void this.startNextQueuedTurn(state.sessionId)
  }

  private async startNextQueuedTurn(sessionId: string): Promise<void> {
    if (this.stopping || this.render.has(sessionId)) return
    const queue = this.queued.get(sessionId)
    const next = queue?.shift()
    if (!next) {
      this.queued.delete(sessionId)
      return
    }
    if (!queue?.length) this.queued.delete(sessionId)
    const inbox = this.deps.inboundInbox
    if (next.inboxEntryId && inbox) {
      try {
        inbox.markDispatching(next.inboxEntryId)
      } catch (error) {
        await next.attachments?.cleanup().catch(() => {})
        this.onAccountStatus(
          next.message.accountId,
          'error',
          `消息 inbox 派发状态落盘失败：${error instanceof Error ? error.message : String(error)}`
        )
        return
      }
    }
    try {
      const accepted = await this.startChannelTurn(
        next.message,
        next.binding,
        next.prompt,
        next.attachments,
        true,
        next.inboxEntryId
      )
      if (next.inboxEntryId && inbox) {
        if (!accepted) {
          inbox.markRecovery(next.inboxEntryId)
          this.onAccountStatus(
            next.message.accountId,
            'error',
            '排队消息未被 Agent Runtime 确认接受'
          )
        }
      }
    } catch (error) {
      if (next.inboxEntryId && inbox) {
        try {
          inbox.markRecovery(next.inboxEntryId)
        } catch {
          /* 保留 dispatching，重启后进入 recovery */
        }
      }
      this.onAccountStatus(
        next.message.accountId,
        'error',
        `排队消息处理状态不确定：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async clearQueuedTurns(sessionId: string): Promise<number> {
    const queue = this.queued.get(sessionId) ?? []
    this.queued.delete(sessionId)
    await Promise.all(queue.map((item) => item.attachments?.cleanup().catch(() => {})))
    // /stop、关闭网关或账号停用是对等待队列的显式终止；同时收口 durable entry，
    // 否则清掉内存队列后 drain 会把用户已经取消的消息再次启动。
    for (const item of queue) {
      if (item.inboxEntryId) this.deps.inboundInbox?.markCompleted(item.inboxEntryId)
    }
    return queue.length
  }

  private async clearAllQueuedTurns(): Promise<void> {
    const sessionIds = [...this.queued.keys()]
    await Promise.all(sessionIds.map((sessionId) => this.clearQueuedTurns(sessionId)))
  }

  private async stopAccountTurns(accountId: string): Promise<void> {
    const queuedSessionIds = [...this.queued.entries()]
      .filter(([, queue]) => queue.some((item) => item.message.accountId === accountId))
      .map(([sessionId]) => sessionId)
    await Promise.all(queuedSessionIds.map((sessionId) => this.clearQueuedTurns(sessionId)))
    const states = [...this.render.values()].filter((state) => state.accountId === accountId)
    await Promise.all(
      states.map(async (state) => {
        await this.deps.interruptTurn(state.sessionId).catch(() => undefined)
        await this.finishState(state, tr('channels.message.gatewayStopped'), 'interrupted')
      })
    )
  }

  /** 单气泡模式持续更新；无 update 能力的平台只在 final=true 时发送一次终态。 */
  private publish(state: RenderState, final: boolean): void {
    this.commitPending(state)
    if (state.updateSupported) {
      this.updateOrSend(state, final)
    } else if (final) {
      const text = state.committed
      if (!text.trim()) return
      this.enqueueSend(state, [{ type: 'text', data: { text } }], true)
    }
  }

  /** 单气泡：有 messageId 则 update；无（占位发送失败/竞态）则新建并记下 id。串行在 sendChain 上。 */
  private updateOrSend(state: RenderState, final: boolean): void {
    const content = state.committed
    if (!content.trim()) return
    state.sendChain = state.sendChain
      .catch(() => {})
      .then(() => {
        if (state.messageId) {
          return this.deps.transport.updateMessage!({
            accountId: state.accountId,
            chatType: state.chatType,
            chatId: state.chatId,
            messageId: state.messageId,
            content,
            final
          })
            .then(() => {
              if (final) state.terminalDelivered = true
              this.updateAccountHealth(state.accountId, {
                lastOutboundAt: new Date().toISOString()
              })
            })
            .catch((err: unknown) => {
              const t = err instanceof Error ? err.message : String(err)
              console.warn(`[channels] update message failed: ${t}`)
              this.updateAccountHealth(state.accountId, { lastErrorAt: new Date().toISOString() })
              if (final) {
                return this.deps.transport
                  .send({
                    accountId: state.accountId,
                    chatType: state.chatType,
                    chatId: state.chatId,
                    segments: [{ type: 'text', data: { text: content } }]
                  })
                  .then(() => {
                    state.terminalDelivered = true
                    this.updateAccountHealth(state.accountId, {
                      lastOutboundAt: new Date().toISOString()
                    })
                  })
              }
              return undefined
            })
        }
        // 占位没发出去：直接发一条正文，记下 id，后续转 update。
        return this.deps.transport.send!({
          accountId: state.accountId,
          chatType: state.chatType,
          chatId: state.chatId,
          segments: [{ type: 'text', data: { text: content } }]
        }).then(
          ({ messageId }) => {
            if (messageId) state.messageId = messageId
            if (final) state.terminalDelivered = true
            this.updateAccountHealth(state.accountId, { lastOutboundAt: new Date().toISOString() })
          },
          (err: unknown) => {
            const t = err instanceof Error ? err.message : String(err)
            console.warn(`[channels] send failed: ${t}`)
            this.updateAccountHealth(state.accountId, { lastErrorAt: new Date().toISOString() })
          }
        )
      })
  }

  /** 降级模式：串行发独立文本消息。 */
  private enqueueSend(state: RenderState, segments: OneBotSegment[], final = false): void {
    state.sendChain = state.sendChain
      .catch(() => {})
      .then(() =>
        this.deps.transport
          .send({
            accountId: state.accountId,
            chatType: state.chatType,
            chatId: state.chatId,
            segments
          })
          .then(
            () => {
              if (final) state.terminalDelivered = true
              this.updateAccountHealth(state.accountId, {
                lastOutboundAt: new Date().toISOString()
              })
            },
            (err) => {
              const text = err instanceof Error ? err.message : String(err)
              console.warn(`[channels] reply failed: ${text}`)
              this.updateAccountHealth(state.accountId, { lastErrorAt: new Date().toISOString() })
            }
          )
      )
  }

  // ─── 发送原语 ──────────────────────────────────────────────────────────────

  private async reply(
    msg: Pick<InboundChannelMessage, 'accountId' | 'chatType' | 'chatId'>,
    segments: OneBotSegment[]
  ): Promise<void> {
    try {
      await this.deps.transport.send({
        accountId: msg.accountId,
        chatType: msg.chatType,
        chatId: msg.chatId,
        segments
      })
      this.updateAccountHealth(msg.accountId, { lastOutboundAt: new Date().toISOString() })
    } catch (err) {
      // 发送失败不应打断后续；Step 2 加重试/退避。
      const text = err instanceof Error ? err.message : String(err)
      console.warn(`[channels] reply failed: ${text}`)
      this.updateAccountHealth(msg.accountId, { lastErrorAt: new Date().toISOString() })
    }
  }

  private routerDeps() {
    return {
      listBindings: getChannelBindings,
      saveBinding: (b: ChannelBinding) => {
        const all = getChannelBindings().filter(
          (x) =>
            !(
              x.platform === b.platform &&
              x.accountId === b.accountId &&
              x.chatType === b.chatType &&
              x.chatId === b.chatId
            )
        )
        setChannelBindings([b, ...all])
      },
      createChannelSession: this.deps.createChannelSession,
      pickDefaultAgent: this.deps.pickDefaultAgent
    }
  }

  private platformLabel(platform: ChannelBinding['platform']): string {
    if (platform === 'feishu') return '飞书'
    if (platform === 'wechat') return '微信'
    if (platform === 'wecom') return '企业微信'
    if (platform === 'telegram') return 'Telegram'
    if (platform === 'whatsapp') return 'WhatsApp'
    return platform
  }

  // ─── IPC 面向：账号/绑定/ACL/网关 ─────────────────────────────────────────

  listAccounts(): ChannelAccount[] {
    return getChannelAccounts().map((account) => this.publicAccount(account))
  }

  addAccount(input: AddChannelAccountInput): ChannelAccount {
    const account: ChannelAccount = {
      id: randomUUID(),
      platform: input.platform,
      alias: input.alias.trim() || input.platform,
      enabled: input.enabled ?? true,
      credentials: input.credentials,
      credentialHint: this.credentialHint(input.credentials)
    }
    setChannelAccounts([...getChannelAccounts(), account])
    const allAcls = getChannelAcls()
    allAcls[account.id] = {
      mode: 'owner',
      ownerId: input.credentials.owner_id || undefined,
      allowlist: []
    }
    setChannelAcls(allAcls)
    if (getChannelsGatewayEnabled() && account.enabled)
      void this.startAccount(account).catch(() => {})
    return this.publicAccount(account)
  }

  async removeAccount(id: string): Promise<void> {
    await this.stopAccountTurns(id)
    await this.deps.transport.stop(id)
    this.deps.inboundInbox?.removeAccount(id)
    setChannelAccounts(getChannelAccounts().filter((a) => a.id !== id))
    setChannelBindings(getChannelBindings().filter((b) => b.accountId !== id))
    setChannelPairingRequests(
      getChannelPairingRequests().filter((request) => request.accountId !== id)
    )
    const acls = getChannelAcls()
    delete acls[id]
    setChannelAcls(acls)
  }

  async setAccountEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const accounts = getChannelAccounts()
    const idx = accounts.findIndex((a) => a.id === id)
    if (idx === -1) return { ok: false, error: tr('channels.error.accountNotFound') }
    accounts[idx] = { ...accounts[idx], enabled }
    setChannelAccounts(accounts)
    try {
      if (!enabled) {
        await this.stopAccountTurns(id)
        if (getChannelsGatewayEnabled()) await this.deps.transport.stop(id)
      } else if (getChannelsGatewayEnabled()) {
        await this.startAccount(accounts[idx])
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async testConnection(
    id: string
  ): Promise<{ ok: boolean; status?: ChannelAccountStatus; error?: string }> {
    const account = getChannelAccounts().find((a) => a.id === id)
    if (!account) return { ok: false, error: tr('channels.error.accountNotFound') }
    try {
      // 这是显式“重新连接”，不能让 transport 的幂等 start 把错误 session 当成成功。
      await this.deps.transport.stop(id)
      await this.startAccount(account)
      const current = getChannelAccounts().find((item) => item.id === id)
      return { ok: true, status: current?.status ?? 'connecting' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async setGatewayEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    setChannelsGatewayEnabled(enabled)
    try {
      if (enabled) {
        if (!this.inboxReady)
          return { ok: false, error: '消息 inbox 不可用，请先修复或移走损坏的 inbox 文件' }
        this.stopping = false
        const errors: string[] = []
        for (const account of getChannelAccounts()) {
          if (!account.enabled) continue
          try {
            await this.startAccount(account)
          } catch (error) {
            errors.push(
              `${account.alias}: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
        if (errors.length) return { ok: false, error: errors.join('\n') }
      } else {
        this.stopping = true
        await this.inboxDrain
        await this.clearAllQueuedTurns()
        await Promise.all(
          [...this.render.values()].map(async (state) => {
            await this.deps.interruptTurn(state.sessionId).catch(() => undefined)
            await this.finishState(state, tr('channels.message.gatewayStopped'), 'interrupted')
          })
        )
        for (const account of getChannelAccounts()) await this.deps.transport.stop(account.id)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  listBindings(): ChannelBinding[] {
    return getChannelBindings()
  }

  // ─── 扫码一键接入（飞书 registerApp / 微信 iLink）──────────────────────────

  async startChannelScan(
    platform: Extract<ChannelPlatform, 'feishu' | 'wechat'> = 'feishu'
  ): Promise<void> {
    if (!this.deps.transport.startOnboarding) {
      this.deps.emitScanResult({ ok: false, platform, error: tr('channels.error.scanUnsupported') })
      return
    }
    this.cancelChannelScan()
    const controller = new AbortController()
    this.scanController = controller
    try {
      const creds = await this.deps.transport.startOnboarding(
        {
          signal: controller.signal,
          onQrCode: (info) => this.deps.emitScanQr({ ...info, platform }),
          requestVerificationCode: (prompt) =>
            this.requestScanVerificationCode(platform, prompt, controller)
        },
        platform
      )
      // 拿到凭证 → 开网关 + 落账号（addAccount 内自动拉起长连接）。
      setChannelsGatewayEnabled(true)
      const credentials =
        platform === 'wechat'
          ? {
              bot_id: creds.appId,
              token: creds.appSecret,
              ...creds.extraCredentials,
              ...(creds.userOpenId ? { owner_id: creds.userOpenId } : {})
            }
          : {
              app_id: creds.appId,
              app_secret: creds.appSecret,
              ...(creds.userOpenId ? { owner_id: creds.userOpenId } : {})
            }
      const account = this.addAccount({
        platform,
        alias: creds.alias || (platform === 'wechat' ? '微信' : '飞书机器人'),
        credentials,
        enabled: true
      })
      this.deps.emitScanResult({ ok: true, platform, accountId: account.id, alias: account.alias })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (controller.signal.aborted) {
        this.deps.emitScanResult({ ok: false, platform, error: tr('channels.error.cancelled') })
      } else {
        this.deps.emitScanResult({ ok: false, platform, error: msg })
      }
    } finally {
      if (this.scanController === controller) this.scanController = null
      this.scanVerification = null
    }
  }

  cancelChannelScan(): void {
    this.scanController?.abort()
    this.scanVerification?.reject(new Error('扫码已取消'))
    this.scanVerification = null
    this.scanController = null
  }

  submitScanVerificationCode(code: string): void {
    const pending = this.scanVerification
    if (!pending) throw new Error('当前没有等待输入的扫码验证码')
    this.scanVerification = null
    pending.resolve(code)
  }

  private requestScanVerificationCode(
    platform: ChannelScanVerification['platform'],
    prompt: string,
    controller: AbortController
  ): Promise<string> {
    this.scanVerification?.reject(new Error('新的验证码请求已替代上一请求'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.scanVerification = null
        reject(new Error('扫码已取消'))
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      this.scanVerification = {
        resolve: (code) => {
          controller.signal.removeEventListener('abort', onAbort)
          resolve(code)
        },
        reject: (error) => {
          controller.signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      }
      this.deps.emitScanVerification({ platform, prompt })
    })
  }

  setBinding(binding: ChannelBinding): ChannelBinding {
    const all = getChannelBindings().filter(
      (b) =>
        !(
          b.platform === binding.platform &&
          b.accountId === binding.accountId &&
          b.chatType === binding.chatType &&
          b.chatId === binding.chatId
        )
    )
    setChannelBindings([binding, ...all])
    return binding
  }

  removeBinding(platform: string, accountId: string, chatId: string): void {
    setChannelBindings(
      getChannelBindings().filter(
        (b) => !(b.platform === platform && b.accountId === accountId && b.chatId === chatId)
      )
    )
  }

  getAcl(accountId: string): ChannelAcl {
    return getChannelAcls()[accountId] ?? { allowlist: [] }
  }

  listPairingRequests(accountId: string): ChannelPairingRequest[] {
    if (!getChannelAccounts().some((account) => account.id === accountId)) {
      throw new Error(tr('channels.error.accountNotFound'))
    }
    return this.prunePairingRequests().filter((request) => request.accountId === accountId)
  }

  async approvePairingRequest(requestId: string): Promise<ChannelAcl> {
    const requests = this.prunePairingRequests()
    const request = requests.find((item) => item.id === requestId)
    if (!request) throw new Error('配对请求不存在或已过期')
    const acls = getChannelAcls()
    const acl = acls[request.accountId]
    if (acl?.mode !== 'owner' || acl.ownerId) throw new Error('该账号已不再等待 owner 配对')
    const approved: ChannelAcl = { mode: 'owner', ownerId: request.userId, allowlist: [] }
    acls[request.accountId] = approved
    setChannelAcls(acls)
    setChannelPairingRequests(requests.filter((item) => item.accountId !== request.accountId))
    await this.notifyPairingDecision(request, 'approved')
    return approved
  }

  async rejectPairingRequest(requestId: string): Promise<void> {
    const requests = this.prunePairingRequests()
    const request = requests.find((item) => item.id === requestId)
    if (!request) throw new Error('配对请求不存在或已过期')
    setChannelPairingRequests(requests.filter((item) => item.id !== requestId))
    await this.notifyPairingDecision(request, 'rejected')
  }

  setAcl(accountId: string, acl: ChannelAcl): void {
    if (!getChannelAccounts().some((account) => account.id === accountId)) {
      throw new Error(tr('channels.error.accountNotFound'))
    }
    if (acl.mode !== 'owner' && acl.mode !== 'allowlist' && acl.mode !== 'open') {
      throw new Error('访问策略必须是 owner、allowlist 或 open')
    }
    if (!Array.isArray(acl.allowlist) || acl.allowlist.length > 500) {
      throw new Error('访问白名单格式无效或超过 500 项')
    }
    const normalizedAllowlist: string[] = []
    for (const value of acl.allowlist) {
      if (typeof value !== 'string') throw new Error('访问白名单只能包含用户 ID')
      const id = value.trim()
      if (!id || id.length > 256) throw new Error('访问白名单包含无效用户 ID')
      if (!normalizedAllowlist.includes(id)) normalizedAllowlist.push(id)
    }
    const ownerId = acl.ownerId?.trim()
    if (ownerId !== undefined && (!ownerId || ownerId.length > 256)) {
      throw new Error('owner 用户 ID 无效')
    }
    const all = getChannelAcls()
    all[accountId] = {
      mode: acl.mode,
      ...(ownerId ? { ownerId } : {}),
      allowlist: acl.mode === 'allowlist' ? normalizedAllowlist : []
    }
    setChannelAcls(all)
    if (ownerId || acl.mode !== 'owner') {
      setChannelPairingRequests(
        getChannelPairingRequests().filter((request) => request.accountId !== accountId)
      )
    }
  }

  private prunePairingRequests(now = Date.now()): ChannelPairingRequest[] {
    const current = getChannelPairingRequests()
    const active = current.filter(
      (request) =>
        typeof request?.id === 'string' &&
        request.id.length > 0 &&
        request.id.length <= 128 &&
        typeof request.accountId === 'string' &&
        request.accountId.length > 0 &&
        request.accountId.length <= 128 &&
        typeof request.userId === 'string' &&
        request.userId.length > 0 &&
        request.userId.length <= 256 &&
        typeof request.chatId === 'string' &&
        request.chatId.length > 0 &&
        request.chatId.length <= 256 &&
        /^[A-HJ-NP-Z2-9]{8}$/.test(request.code || '') &&
        Number.isFinite(Date.parse(request.createdAt)) &&
        Date.parse(request.expiresAt) > now
    )
    if (active.length !== current.length) setChannelPairingRequests(active)
    return active
  }

  private createOrReusePairingRequest(
    message: InboundChannelMessage
  ): ChannelPairingRequest | null {
    const requests = this.prunePairingRequests()
    const existing = requests.find(
      (request) => request.accountId === message.accountId && request.userId === message.userId
    )
    if (existing) return existing
    if (
      requests.filter((request) => request.accountId === message.accountId).length >=
      CHANNEL_PAIRING_MAX_PENDING
    ) {
      return null
    }
    const createdAt = new Date()
    const request: ChannelPairingRequest = {
      id: randomUUID(),
      accountId: message.accountId,
      platform: message.platform,
      userId: message.userId,
      ...(message.userName ? { userName: message.userName } : {}),
      chatId: message.chatId,
      code: channelPairingCode(),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + CHANNEL_PAIRING_TTL_MS).toISOString()
    }
    setChannelPairingRequests([...requests, request])
    return request
  }

  private async notifyPairingDecision(
    request: ChannelPairingRequest,
    decision: 'approved' | 'rejected'
  ): Promise<void> {
    try {
      await this.deps.transport.send({
        accountId: request.accountId,
        chatType: 'private',
        chatId: request.chatId,
        segments: [
          {
            type: 'text',
            data: {
              text: tr(
                decision === 'approved'
                  ? 'channels.message.pairingApproved'
                  : 'channels.message.pairingRejected'
              )
            }
          }
        ]
      })
      this.updateAccountHealth(request.accountId, { lastOutboundAt: new Date().toISOString() })
    } catch {
      // 审批决定已经落盘；平台通知失败不得反向撤销权限或恢复请求。
      this.updateAccountHealth(request.accountId, { lastErrorAt: new Date().toISOString() })
    }
  }

  private publicAccount(account: ChannelAccount): ChannelAccount {
    return {
      ...account,
      credentialHint: account.credentialHint || this.credentialHint(account.credentials),
      credentials: {}
    }
  }

  private credentialHint(credentials: Record<string, string>): string | undefined {
    const value =
      credentials.app_id ||
      credentials.bot_id ||
      credentials.bot_token ||
      credentials.phone_number_id
    if (!value) return undefined
    if (value.length <= 10) return `${value.slice(0, 2)}…${value.slice(-2)}`
    return `${value.slice(0, 6)}…${value.slice(-4)}`
  }

  private updateAccountHealth(
    accountId: string,
    patch: Partial<NonNullable<ChannelAccount['health']>>
  ): void {
    const accounts = getChannelAccounts()
    const index = accounts.findIndex((account) => account.id === accountId)
    if (index < 0) return
    accounts[index] = {
      ...accounts[index],
      health: { ...accounts[index].health, ...patch }
    }
    setChannelAccounts(accounts)
    this.deps.emitAccountState(this.publicAccount(accounts[index]))
  }
}
