import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
// @ts-expect-error cross-spawn 7.x 未发布 TypeScript declarations。
import crossSpawn from 'cross-spawn'
// cross-spawn 在 Windows 上自动识别 .cmd/.bat 并以正确的 argv 转义启动，
// 避免无 shell 直接 spawn 扩展名缺失的 npm shim 触发 ENOENT，
// 同时保住 --settings 等 JSON 参数中的内嵌引号（plain shell:true 会破坏）。
// 收窄实际使用的调用签名，避免把未声明类型扩散到 ChatManager。
const spawnCrossPlatform = crossSpawn as (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: Array<'pipe' | 'ignore' | 'inherit'> }
) => SpawnedTurn
import type { CliAdapter, HeadlessTurnParser } from '../adapters/types'
import { assertAttachmentsSupported } from '../adapters/attachments'
import { extractSessionId } from '../adapters/headless-utils'
import { discoverWithProviders } from '../discovery/providers'
import type {
  AgentEvent,
  ChatTurnMessage,
  ChatTurnState,
  ManagedChatMessage,
  ManagedChatMessageStatus,
  ManagedChatPermissionStatus,
  ManagedQueuedTurn,
  ManagedChatTimelineItem,
  PermissionDecision,
  ReferencedMemory,
  TurnContextPack,
  WorkbenchSession
} from '@shared/types'
import { serializeTurnWithContext } from '@shared/turn-context'
import {
  startApprovalBridge,
  type ApprovalBridge,
  type ApprovalHookDecision,
  type ApprovalHookInput
} from './approval-bridge'
import { tr } from '@shared/i18n'

interface SpawnedTurn {
  stdout: Readable
  stderr: Readable
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

type ChatMessagePatch = {
  text?: string
  status?: ManagedChatMessageStatus
  referencedMemories?: ReferencedMemory[]
}

export interface MemoryContextResult {
  text: string
  referencedMemories: ReferencedMemory[]
}

interface ChatManagerOptions {
  approvalToken: string
  getSession(id: string): WorkbenchSession | null
  bindNativeSession(id: string, nativeSessionId: string | null): WorkbenchSession | null
  listChatHistory?(id: string): ManagedChatMessage[]
  appendChatMessage?(
    id: string,
    message: Omit<ManagedChatMessage, 'id' | 'createdAt' | 'updatedAt'>
  ): ManagedChatMessage
  updateChatMessage?(
    id: string,
    messageId: string,
    patch: ChatMessagePatch
  ): ManagedChatMessage | null
  listTimeline?(id: string): ManagedChatTimelineItem[]
  appendTimelineItem?(
    item: Omit<ManagedChatTimelineItem, 'id' | 'createdAt'>
  ): ManagedChatTimelineItem
  listQueuedTurns?(sessionId: string): ManagedQueuedTurn[]
  enqueueTurn?(
    sessionId: string,
    input: { text: string; files?: string[]; contextPack?: TurnContextPack }
  ): ManagedQueuedTurn
  cancelQueuedTurn?(sessionId: string, queuedTurnId: string): boolean
  updatePermissionStatus?(
    sessionId: string,
    turnId: string,
    toolUseId: string,
    status: ManagedChatPermissionStatus
  ): ManagedChatTimelineItem | null
  nextTimelineSeq?(sessionId: string): number
  getAdapter(toolId: string): CliAdapter | undefined
  getProviderEnv(toolId: string): Record<string, string>
  getProviderModel(toolId: string): string | undefined
  /**
   * 回合开始时生成有预算的 Context Pack。text 注入 prompt；referencedMemories 仅作
   * "参考了哪些记忆"的只读回显。返回 text 空串代表不注入。
   */
  memoryContext?(session: WorkbenchSession, prompt: string): MemoryContextResult
  /** 成功回合完成后交给长期记忆调度器；不得阻塞聊天状态迁移。 */
  onStableConversation?(session: WorkbenchSession, messages: ManagedChatMessage[]): void
  spawn?(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ): SpawnedTurn
  emit(
    sessionId: string,
    event: AgentEvent,
    timelineItem?: ManagedChatTimelineItem,
    turnId?: string
  ): void
}

interface PendingPermission {
  requestId: string
  toolUseId: string
  toolName: string
}

interface LogicalTurn {
  sessionId: string
  nativeSessionId: string | null
  process: SpawnedTurn | null
  processId: string
  interrupted: boolean
  sawTurnEnd: boolean
  decisions: Map<string, PermissionDecision>
  pending: PendingPermission | null
  /** 本回合解析器（持有跨行状态），每次 spawn 重建。 */
  parser: HeadlessTurnParser
  /** 用户可见的逻辑回合 id；审批重启子进程时保持不变。 */
  turnId: string
  nextSeq: number
  /** stdout 协议里解析到的最近运行错误；用于进程失败时保留真实根因。 */
  lastRuntimeError: string | null
  toolNames: Map<string, string>
  startupTimer: NodeJS.Timeout | null
  /** 本回合的用户消息（用于无原生 resume 适配器的历史累积）。 */
  prompt: string
  /** 本回合累积的助手文本（用于历史累积）。 */
  assistantText: string
  userMessageId: string
  assistantMessageId: string
  /** 附件文件路径列表。 */
  files?: string[]
  /** controller 生成的上下文快照；daemon/远程端不得自行读取 controller Vault。 */
  contextPack?: TurnContextPack
}

const SAFE_AUTO_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const ACCEPT_EDITS_AUTO_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit'])

function initialState(sessionId: string): ChatTurnState {
  const now = new Date().toISOString()
  return {
    sessionId,
    turnId: null,
    status: 'idle',
    startedAt: null,
    updatedAt: now,
    pendingPermission: null,
    error: null,
    queuedCount: 0
  }
}

export class ChatManager {
  private readonly turns = new Map<string, LogicalTurn>()
  private readonly turnByProcessId = new Map<string, LogicalTurn>()
  private readonly states = new Map<string, ChatTurnState>()
  /** 测试/嵌入方未提供仓储方法时的兼容内存存储。正式运行由 FileSessionRepository 持久化。 */
  private readonly fallbackHistory = new Map<string, ManagedChatMessage[]>()
  private readonly fallbackQueuedTurns = new Map<string, ManagedQueuedTurn[]>()
  private readonly alwaysAllowedBySession = new Map<string, Set<string>>()
  private readonly executablePaths = new Map<string, string>()
  private bridge!: ApprovalBridge

  private constructor(private readonly options: ChatManagerOptions) {}

  static async create(options: ChatManagerOptions): Promise<ChatManager> {
    const manager = new ChatManager(options)
    manager.bridge = await startApprovalBridge({
      token: options.approvalToken,
      handle: (input) => manager.handleApprovalHook(input)
    })
    return manager
  }

  get approvalUrl(): string {
    return this.bridge.url
  }

  activeTurnId(sessionId: string): string | null {
    return this.turns.get(sessionId)?.processId ?? null
  }

  state(sessionId: string): ChatTurnState {
    if (!this.turns.has(sessionId)) this.drainQueuedTurn(sessionId)
    return this.decorateState(sessionId, this.baseState(sessionId))
  }

  history(sessionId: string): ManagedChatMessage[] {
    return this.listHistory(sessionId)
  }

  timeline(sessionId: string): ManagedChatTimelineItem[] {
    return this.options.listTimeline?.(sessionId) ?? []
  }

  async sendTurn(
    sessionId: string,
    prompt: string,
    files?: string[],
    contextPack?: TurnContextPack
  ): Promise<ChatTurnState> {
    if (this.turns.has(sessionId)) throw new Error(tr('chat.error.turnInProgress'))
    return this.startTurn(sessionId, prompt, files, contextPack)
  }

  async steer(sessionId: string, prompt: string, files?: string[]): Promise<ChatTurnState> {
    this.requireChatSession(sessionId)
    const text = prompt.trim()
    if (!text) throw new Error(tr('chat.error.emptyPrompt'))
    if (!this.turns.has(sessionId)) return this.startTurn(sessionId, text, files)
    const interrupted = await this.interruptCurrent(sessionId, false)
    if (!interrupted) throw new Error(tr('chat.error.steerFailed'))
    return this.startTurn(sessionId, text, files)
  }

  queueTurn(
    sessionId: string,
    prompt: string,
    files?: string[],
    contextPack?: TurnContextPack
  ): ManagedQueuedTurn {
    this.requireChatSession(sessionId)
    const text = prompt.trim()
    if (!text) throw new Error(tr('chat.error.emptyPrompt'))
    const queued = this.enqueueQueuedTurn(sessionId, { text, files, contextPack })
    if (!this.turns.has(sessionId)) this.drainQueuedTurn(sessionId)
    this.setState(sessionId, {})
    return queued
  }

  listQueuedTurns(sessionId: string): ManagedQueuedTurn[] {
    return this.listQueued(sessionId)
  }

  cancelQueuedTurn(sessionId: string, queuedTurnId: string): boolean {
    const removed = this.cancelQueued(sessionId, queuedTurnId)
    if (removed) this.setState(sessionId, {})
    return removed
  }

  private startTurn(
    sessionId: string,
    prompt: string,
    files?: string[],
    contextPack?: TurnContextPack
  ): ChatTurnState {
    const session = this.requireChatSession(sessionId)
    const channel = this.options.getAdapter(session.toolId)!.headlessJson!
    assertAttachmentsSupported(session.toolId, channel.attachments, files)
    const userMessage = this.appendMessage(sessionId, {
      role: 'user',
      text: prompt,
      status: 'completed'
    })
    const assistantMessage = this.appendMessage(sessionId, {
      role: 'assistant',
      text: '',
      status: 'streaming'
    })
    const turn: LogicalTurn = {
      sessionId,
      nativeSessionId: session.nativeSessionId,
      process: null,
      processId: randomUUID(),
      turnId: randomUUID(),
      nextSeq: this.options.nextTimelineSeq?.(sessionId) ?? 1,
      lastRuntimeError: null,
      toolNames: new Map(),
      startupTimer: null,
      interrupted: false,
      sawTurnEnd: false,
      decisions: new Map(),
      pending: null,
      parser: channel.createParser(),
      prompt,
      assistantText: '',
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      ...(files?.length ? { files } : {}),
      ...(contextPack ? { contextPack } : {})
    }
    this.turns.set(sessionId, turn)
    this.setState(sessionId, {
      turnId: turn.turnId,
      status: 'running',
      startedAt: new Date().toISOString(),
      pendingPermission: null,
      error: null
    })
    this.spawnTurn(turn, prompt)
    return this.state(sessionId)
  }

  async interrupt(sessionId: string): Promise<boolean> {
    return this.interruptCurrent(sessionId, true)
  }

  private async interruptCurrent(sessionId: string, drainQueue: boolean): Promise<boolean> {
    const turn = this.turns.get(sessionId)
    if (!turn) return false
    turn.interrupted = true
    this.clearStartupTimer(turn)
    turn.process?.kill('SIGTERM')
    this.options.emit(
      sessionId,
      { kind: 'turn-end', status: 'interrupted' },
      undefined,
      turn.turnId
    )
    this.updateMessage(sessionId, turn.assistantMessageId, {
      text: turn.assistantText,
      status: 'interrupted'
    })
    this.setState(sessionId, {
      turnId: null,
      status: 'interrupted',
      pendingPermission: null,
      error: null
    })
    this.turnByProcessId.delete(turn.processId)
    this.turns.delete(sessionId)
    if (drainQueue) this.drainQueuedTurn(sessionId)
    return true
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<ChatTurnState> {
    const turn = this.turns.get(sessionId)
    if (!turn?.pending || turn.pending.requestId !== requestId) {
      throw new Error(tr('chat.error.approvalExpired'))
    }
    turn.decisions.set(turn.pending.toolUseId, decision)
    if (decision === 'always') {
      const allowed = this.alwaysAllowedBySession.get(sessionId) ?? new Set()
      allowed.add(turn.pending.toolName)
      this.alwaysAllowedBySession.set(sessionId, allowed)
    }
    const permissionStatus: ManagedChatPermissionStatus =
      decision === 'always' ? 'allowed-always' : decision === 'once' ? 'allowed-once' : 'denied'
    this.options.updatePermissionStatus?.(
      sessionId,
      turn.turnId,
      turn.pending.toolUseId,
      permissionStatus
    )
    turn.pending = null
    this.setState(sessionId, {
      status: 'running',
      pendingPermission: null,
      error: null
    })
    turn.processId = randomUUID()
    turn.sawTurnEnd = false
    const channel = this.options.getAdapter(
      this.requireChatSession(sessionId).toolId
    )!.headlessJson!
    turn.parser = channel.createParser()
    this.spawnTurn(turn)
    return this.state(sessionId)
  }

  async close(): Promise<void> {
    for (const turn of this.turns.values()) {
      this.clearStartupTimer(turn)
      turn.process?.kill('SIGTERM')
    }
    this.turns.clear()
    this.turnByProcessId.clear()
    this.alwaysAllowedBySession.clear()
    this.fallbackHistory.clear()
    this.fallbackQueuedTurns.clear()
    await this.bridge.close()
  }

  /** 会话删除时释放所有会话级常驻缓存，避免长期创建/删除会话后 Map 只增不减。 */
  async forgetSession(sessionId: string): Promise<void> {
    for (const queued of this.listQueued(sessionId)) this.cancelQueued(sessionId, queued.id)
    await this.interrupt(sessionId)
    this.states.delete(sessionId)
    this.alwaysAllowedBySession.delete(sessionId)
    this.fallbackHistory.delete(sessionId)
    this.fallbackQueuedTurns.delete(sessionId)
  }

  private requireChatSession(sessionId: string): WorkbenchSession {
    const session = this.options.getSession(sessionId)
    if (!session) throw new Error(tr('chat.error.sessionNotFound'))
    if (session.surface !== 'chat') throw new Error(tr('chat.error.notChatSurface'))
    const adapter = this.options.getAdapter(session.toolId)
    if (!adapter?.headlessJson) throw new Error(tr('chat.error.noStructuredChat'))
    return session
  }

  private spawnTurn(turn: LogicalTurn, prompt?: string): void {
    const session = this.requireChatSession(turn.sessionId)
    const channel = this.options.getAdapter(session.toolId)!.headlessJson!
    const memory = turn.contextPack
      ? turn.contextPack
      : prompt && session.memoryUse !== false
        ? this.options.memoryContext?.(session, prompt)
        : undefined
    const context = memory?.text ?? ''
    const promptWithMemory = prompt
      ? serializeTurnWithContext(
          prompt,
          context
            ? {
                version: 1,
                text: context,
                referencedMemories: memory?.referencedMemories ?? [],
                generatedAt: turn.contextPack?.generatedAt ?? new Date().toISOString(),
                estimatedTokens: turn.contextPack?.estimatedTokens ?? Math.ceil(context.length / 3)
              }
            : undefined
        )
      : undefined
    // 把本回合实际注入的记忆引用回写到 assistant 消息，供 UI 只读展示"参考了哪些记忆"。
    if (memory?.referencedMemories.length) {
      this.updateMessage(turn.sessionId, turn.assistantMessageId, {
        referencedMemories: memory.referencedMemories
      })
    }
    // 有原生会话记忆的适配器（claude）用 CLI 自带 resume；其余把历史
    // transcript 重组进 prompt（SPEC-019）。
    const transcript = channel.supportsNativeResume
      ? undefined
      : this.listHistory(turn.sessionId)
          .filter(
            (message) =>
              message.id !== turn.userMessageId &&
              message.id !== turn.assistantMessageId &&
              message.text.trim()
          )
          .map<ChatTurnMessage>((message) => ({
            role: message.role,
            text: message.text
          }))
    const launch = channel.buildTurn({
      ...(promptWithMemory ? { prompt: promptWithMemory } : {}),
      ...(channel.supportsNativeResume && turn.nativeSessionId
        ? { nativeSessionId: turn.nativeSessionId }
        : {}),
      ...(transcript ? { transcript } : {}),
      permissionPreset: session.permissionPreset,
      // 会话级模型覆盖优先；否则回退 provider 配置的默认模型。
      ...((session.model ?? this.options.getProviderModel(session.toolId))
        ? { model: session.model ?? this.options.getProviderModel(session.toolId) }
        : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      approvalUrl: this.approvalUrl,
      approvalToken: this.options.approvalToken,
      turnId: turn.processId,
      ...(turn.files?.length ? { files: turn.files } : {})
    })
    // Windows 用 cross-spawn（自动识别 .cmd/.bat、正确转义 argv，避免 EINVAL/ENOENT）；
    // macOS/Linux 保持原生 node:child_process.spawn，行为与改造前完全一致。
    const spawn =
      this.options.spawn ??
      ((command, args, options) =>
        process.platform === 'win32'
          ? spawnCrossPlatform(command, args, {
              cwd: options.cwd,
              env: options.env,
              stdio: ['pipe', 'pipe', 'pipe']
            })
          : (nodeSpawn(command, args, {
              cwd: options.cwd,
              env: options.env,
              stdio: ['pipe', 'pipe', 'pipe']
            }) as SpawnedTurn))
    const processId = turn.processId
    const command = this.options.spawn ? launch.command : this.resolveExecutable(launch.command)
    const child = spawn(command, launch.args, {
      cwd: existsSync(session.workspacePath) ? session.workspacePath : homedir(),
      env: {
        ...process.env,
        ...this.options.getProviderEnv(session.toolId),
        ...launch.env
      }
    })
    turn.process = child
    let sawAgentEvent = false
    // 流式 CLI（claude/codex/gemini）开局即吐事件，用默认 90s 看门狗抓启动卡死；
    // 批量 CLI（hermes --quiet 仅在结束才输出）通过 startupTimeoutMs 放宽，null 则
    // 禁用看门狗、仅靠进程退出收尾。看门狗只在「从未观察到任何 agent 事件」时触发。
    const startupTimeoutMs = channel.startupTimeoutMs ?? 90_000
    if (startupTimeoutMs !== null) {
      turn.startupTimer = setTimeout(() => {
        if (sawAgentEvent) return
        if (!this.turns.has(turn.sessionId) || turn.processId !== processId) return
        turn.process?.kill('SIGTERM')
        this.failTurn(turn, tr('chat.error.startupTimeout', { toolId: session.toolId }))
      }, startupTimeoutMs)
      turn.startupTimer.unref()
    }

    // prompt 经 stdin 投递（避免 argv 长度上限）。无 stdin 的适配器（claude
    // 走 argv）直接关闭 stdin 让子进程继续。
    const stdin = (child as unknown as { stdin?: NodeJS.WritableStream | null }).stdin
    if (stdin) {
      stdin.on('error', () => {
        /* 子进程提前关闭读端的 EPIPE 由 exit/error 处理器兜底 */
      })
      try {
        if (typeof launch.stdin === 'string') stdin.end(launch.stdin)
        else stdin.end()
      } catch {
        /* 忽略写入竞态，失败由 exit 处理 */
      }
    }
    this.turnByProcessId.set(processId, turn)

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      for (const event of turn.parser.parse(line)) {
        sawAgentEvent = true
        if (event.kind === 'session-bound') {
          turn.nativeSessionId = event.nativeSessionId
          this.options.bindNativeSession(turn.sessionId, event.nativeSessionId)
        }
        const timelineItem = this.persistTimelineEvent(turn, event)
        if (event.kind === 'text-delta') {
          turn.assistantText += event.text
          this.updateMessage(turn.sessionId, turn.assistantMessageId, {
            text: turn.assistantText,
            status: 'streaming'
          })
        }
        if (event.kind === 'turn-end') {
          turn.sawTurnEnd = true
          // 立即置 idle，不等进程退出；进程 exit 时若 sawTurnEnd=true 不会再重置。
          this.setState(turn.sessionId, {
            turnId: null,
            status: 'idle',
            pendingPermission: null,
            error: null
          })
        }
        if (event.kind === 'error') {
          turn.lastRuntimeError = event.message
        }
        this.options.emit(turn.sessionId, event, timelineItem, turn.turnId)
      }
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000)
    })
    child.on('error', (error) => {
      this.clearStartupTimer(turn)
      if (turn.processId === processId) this.failTurn(turn, error.message)
    })
    child.on('exit', (code) => {
      this.clearStartupTimer(turn)
      this.turnByProcessId.delete(processId)
      if (turn.interrupted || !this.turns.has(turn.sessionId) || turn.processId !== processId) {
        return
      }
      if (turn.pending) return
      if (code === 0) {
        // 兜底：部分适配器（hermes --quiet）把 native session id 打到 stderr 而非
        // stdout，stdout 解析器全程拿不到 session-bound。回合成功结束时若尚未绑定，
        // 从缓冲的 stderr 抽出 session id 绑给会话，供下一回合 --resume 接续多轮记忆。
        if (!turn.nativeSessionId) {
          const fromStderr = stderr
            .split('\n')
            .reduce<string | null>((found, line) => found ?? extractSessionId(line.trim()), null)
          if (fromStderr) {
            turn.nativeSessionId = fromStderr
            this.options.bindNativeSession(turn.sessionId, fromStderr)
          }
        }
        if (!turn.sawTurnEnd) {
          this.options.emit(
            turn.sessionId,
            {
              kind: 'turn-end',
              status: 'completed'
            },
            undefined,
            turn.turnId
          )
        }
        this.updateMessage(turn.sessionId, turn.assistantMessageId, {
          text: turn.assistantText,
          status: 'completed'
        })
        this.setState(turn.sessionId, {
          turnId: null,
          status: 'idle',
          pendingPermission: null,
          error: null
        })
        this.turns.delete(turn.sessionId)
        try {
          this.options.onStableConversation?.(session, this.listHistory(turn.sessionId))
        } catch {
          // 记忆调度是旁路增强，绝不能影响已完成回合。
        }
        this.drainQueuedTurn(turn.sessionId)
      } else {
        const stderrMessage = stderr.trim()
        const failureMessage =
          turn.lastRuntimeError ||
          stderrMessage ||
          tr('chat.error.turnExited', { code: code ?? 'unknown' })
        this.failTurn(turn, failureMessage)
      }
    })
  }

  private async handleApprovalHook(input: ApprovalHookInput): Promise<ApprovalHookDecision> {
    const turn = this.turnByProcessId.get(input.turnId)
    if (!turn) return 'deny'
    if (input.sessionId && !turn.nativeSessionId) {
      turn.nativeSessionId = input.sessionId
      this.options.bindNativeSession(turn.sessionId, input.sessionId)
    }
    const session = this.requireChatSession(turn.sessionId)
    const preset = session.permissionPreset
    if (
      preset === 'auto' ||
      this.alwaysAllowedBySession.get(turn.sessionId)?.has(input.toolName) ||
      (preset === 'safe' && SAFE_AUTO_TOOLS.has(input.toolName)) ||
      (preset === 'acceptEdits' && ACCEPT_EDITS_AUTO_TOOLS.has(input.toolName))
    ) {
      return 'allow'
    }
    const decided = turn.decisions.get(input.toolUseId)
    if (decided) {
      turn.decisions.delete(input.toolUseId)
      return decided === 'deny' ? 'deny' : 'allow'
    }

    const requestId = randomUUID()
    turn.pending = {
      requestId,
      toolUseId: input.toolUseId,
      toolName: input.toolName
    }
    const event: Extract<AgentEvent, { kind: 'permission-request' }> = {
      kind: 'permission-request',
      requestId,
      toolName: input.toolName,
      input: input.toolInput,
      suggestions: input.permissionSuggestions
    }
    const timelineItem = this.persistTimelineEvent(turn, event)
    this.options.emit(turn.sessionId, event, timelineItem, turn.turnId)
    this.setState(turn.sessionId, {
      status: 'awaiting-permission',
      pendingPermission: event,
      error: null
    })
    return 'defer'
  }

  private resolveExecutable(command: string): string {
    if (existsSync(command)) return command
    const cached = this.executablePaths.get(command)
    if (cached) return cached
    const resolved = discoverWithProviders(command).matchedPath ?? command
    // Windows：cross-spawn 对「显式路径」（无论 .cmd 还是 .exe）都会得到空 stdout
    // （cmd.exe 对反斜杠路径的转义问题，实测 node.exe/claude.cmd 均如此）；
    // 改用原始命令名让 cross-spawn 按 PATH+PATHEXT 自行解析，才能正确产出 stream-json。
    // 因此 win32 下一律用命令名；macOS/Linux 仍用解析到的路径（posix 无此问题）。
    const target = process.platform === 'win32' ? command : resolved
    this.executablePaths.set(command, target)
    return target
  }

  private failTurn(turn: LogicalTurn, message: string): void {
    this.clearStartupTimer(turn)
    this.updateMessage(turn.sessionId, turn.assistantMessageId, {
      text: turn.assistantText,
      status: 'failed'
    })
    const event: AgentEvent = { kind: 'error', message }
    const timelineItem = this.persistTimelineEvent(turn, event)
    this.options.emit(turn.sessionId, event, timelineItem, turn.turnId)
    this.setState(turn.sessionId, {
      turnId: null,
      status: 'failed',
      pendingPermission: null,
      error: message
    })
    this.turnByProcessId.delete(turn.processId)
    this.turns.delete(turn.sessionId)
    this.drainQueuedTurn(turn.sessionId)
  }

  private listHistory(sessionId: string): ManagedChatMessage[] {
    return (
      this.options.listChatHistory?.(sessionId) ?? [...(this.fallbackHistory.get(sessionId) ?? [])]
    )
  }

  private listQueued(sessionId: string): ManagedQueuedTurn[] {
    return (
      this.options.listQueuedTurns?.(sessionId) ?? [
        ...(this.fallbackQueuedTurns.get(sessionId) ?? [])
      ]
    )
  }

  private enqueueQueuedTurn(
    sessionId: string,
    input: { text: string; files?: string[]; contextPack?: TurnContextPack }
  ): ManagedQueuedTurn {
    if (this.options.enqueueTurn) return this.options.enqueueTurn(sessionId, input)
    const now = new Date().toISOString()
    const created: ManagedQueuedTurn = {
      id: randomUUID(),
      sessionId,
      text: input.text,
      files: input.files ?? [],
      ...(input.contextPack ? { contextPack: input.contextPack } : {}),
      status: 'queued',
      createdAt: now,
      updatedAt: now
    }
    const queued = this.fallbackQueuedTurns.get(sessionId) ?? []
    queued.push(created)
    this.fallbackQueuedTurns.set(sessionId, queued)
    return created
  }

  private cancelQueued(sessionId: string, queuedTurnId: string): boolean {
    if (this.options.cancelQueuedTurn) return this.options.cancelQueuedTurn(sessionId, queuedTurnId)
    const queued = this.fallbackQueuedTurns.get(sessionId) ?? []
    const index = queued.findIndex((turn) => turn.id === queuedTurnId)
    if (index === -1) return false
    queued.splice(index, 1)
    this.fallbackQueuedTurns.set(sessionId, queued)
    return true
  }

  private drainQueuedTurn(sessionId: string): void {
    if (this.turns.has(sessionId)) return
    const next = this.listQueued(sessionId)[0]
    if (!next) return
    if (!this.cancelQueued(sessionId, next.id)) return
    this.startTurn(
      sessionId,
      next.text,
      next.files.length ? next.files : undefined,
      next.contextPack
    )
  }

  private persistTimelineEvent(
    turn: LogicalTurn,
    event: AgentEvent
  ): ManagedChatTimelineItem | undefined {
    if (!this.options.appendTimelineItem) return undefined
    const seq = turn.nextSeq++
    try {
      if (event.kind === 'text-delta') {
        return this.options.appendTimelineItem({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          seq,
          type: 'text',
          content: event.text
        })
      }
      if (event.kind === 'thinking-delta') {
        return this.options.appendTimelineItem({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          seq,
          type: 'thinking',
          content: event.text
        })
      }
      if (event.kind === 'error' && event.retryable) {
        return this.options.appendTimelineItem({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          seq,
          type: 'thinking',
          content: `${event.message}\n`
        })
      }
      if (event.kind === 'tool-start') {
        turn.toolNames.set(event.toolUseId, event.toolName)
        return this.options.appendTimelineItem({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          seq,
          type: 'tool_use',
          tool: event.toolName,
          toolUseId: event.toolUseId,
          input: event.input
        })
      }
      if (event.kind === 'tool-result') {
        return this.options.appendTimelineItem({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          seq,
          type: 'tool_result',
          tool: turn.toolNames.get(event.toolUseId),
          toolUseId: event.toolUseId,
          output: event.content,
          isError: event.isError
        })
      }
      if (event.kind === 'permission-request') {
        const toolUseId = turn.pending?.toolUseId ?? event.requestId
        return this.options.appendTimelineItem({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          seq,
          type: 'permission',
          tool: event.toolName,
          toolUseId,
          input: event.input,
          status: 'pending'
        })
      }
      if (event.kind === 'error' && !event.retryable) {
        return this.options.appendTimelineItem({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          seq,
          type: 'error',
          content: event.message,
          isError: true
        })
      }
    } catch {
      // timeline 是体验增强，不允许存储失败打断正在运行的 agent。
    }
    return undefined
  }

  private appendMessage(
    sessionId: string,
    message: Omit<ManagedChatMessage, 'id' | 'createdAt' | 'updatedAt'>
  ): ManagedChatMessage {
    if (this.options.appendChatMessage) {
      return this.options.appendChatMessage(sessionId, message)
    }
    const now = new Date().toISOString()
    const created: ManagedChatMessage = {
      ...message,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    }
    const history = this.fallbackHistory.get(sessionId) ?? []
    history.push(created)
    this.fallbackHistory.set(sessionId, history)
    return created
  }

  private updateMessage(
    sessionId: string,
    messageId: string,
    patch: ChatMessagePatch
  ): ManagedChatMessage | null {
    if (this.options.updateChatMessage) {
      return this.options.updateChatMessage(sessionId, messageId, patch)
    }
    const history = this.fallbackHistory.get(sessionId) ?? []
    const index = history.findIndex((message) => message.id === messageId)
    if (index === -1) return null
    history[index] = {
      ...history[index],
      ...patch,
      updatedAt: new Date().toISOString()
    }
    return history[index]
  }

  private clearStartupTimer(turn: LogicalTurn): void {
    if (!turn.startupTimer) return
    clearTimeout(turn.startupTimer)
    turn.startupTimer = null
  }

  private setState(
    sessionId: string,
    patch: Partial<Omit<ChatTurnState, 'sessionId' | 'updatedAt'>>
  ): void {
    const current = this.baseState(sessionId)
    this.states.set(sessionId, {
      ...current,
      ...patch,
      sessionId,
      updatedAt: new Date().toISOString(),
      queuedCount: this.listQueued(sessionId).length
    })
  }

  private baseState(sessionId: string): ChatTurnState {
    return this.states.get(sessionId) ?? initialState(sessionId)
  }

  private decorateState(sessionId: string, state: ChatTurnState): ChatTurnState {
    return {
      ...state,
      queuedCount: this.listQueued(sessionId).length
    }
  }
}
