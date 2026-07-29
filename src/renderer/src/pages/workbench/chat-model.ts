import type {
  AgentEvent,
  ChatTurnStatus,
  ManagedChatMessage,
  ManagedChatPermissionStatus,
  ManagedChatTimelineItem,
  NormalizedMessage
} from '@shared/types'
import { tr } from '@shared/i18n'

export type ProcessStepKind = 'thinking' | 'tool' | 'permission' | 'error'

export interface ProcessStep {
  id: string
  kind: ProcessStepKind
  title: string
  detail?: string
  tool?: string
  input?: unknown
  output?: string
  isError?: boolean
  status?: ManagedChatPermissionStatus
  createdAt: string
}

export type ChatItem =
  | {
      id: string
      kind: 'message'
      role: 'user' | 'assistant' | 'system'
      text: string
      /** CLI 历史消息序号（用于标注层 msg:cli ref）。 */
      seq?: number
      /** 自建对话消息 UUID（用于标注层 msg:managed ref）。 */
      messageId?: string
    }
  | {
      id: string
      kind: 'thinking'
      text: string
    }
  | {
      id: string
      kind: 'tool'
      toolUseId: string
      toolName: string
      input: unknown
      result?: string
      isError?: boolean
    }
  | {
      id: string
      kind: 'permission'
      requestId: string
      toolName: string
      input: unknown
    }
  | {
      id: string
      kind: 'unknown'
      rawType: string
      payload: unknown
    }
  | {
      id: string
      kind: 'process'
      turnId: string
      title: string
      status: 'running' | 'completed' | 'awaiting' | 'failed'
      defaultOpen: boolean
      steps: ProcessStep[]
    }

export function transcriptItems(messages: NormalizedMessage[]): ChatItem[] {
  return transcriptHistoryItems(messages)
}

export function transcriptHistoryItems(messages: NormalizedMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  let processSteps: ProcessStep[] = []

  const flushProcess = (): void => {
    if (processSteps.length === 0) return
    const first = processSteps[0]
    items.push({
      id: `history-process-${first.id}`,
      kind: 'process',
      turnId: `history-${first.id}`,
      title: tr('chat.process.historyTitle'),
      status: processSteps.some((step) => step.isError) ? 'failed' : 'completed',
      defaultOpen: false,
      steps: processSteps
    })
    processSteps = []
  }

  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    const text = message.text.trim()
    if (!text || shouldHideTranscriptMessage(message, text)) continue

    const step = transcriptProcessStep(message, text)
    if (step) {
      processSteps.push(step)
      continue
    }

    flushProcess()
    items.push({
      id: `history-${message.seq}`,
      kind: 'message',
      role: message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system',
      text,
      seq: message.seq
    })
  }

  flushProcess()
  return items
}

export function appendUserMessage(items: ChatItem[], text: string, id: string): ChatItem[] {
  return [...items, { id, kind: 'message', role: 'user', text }]
}

export function managedItems(messages: ManagedChatMessage[]): ChatItem[] {
  return messages
    .filter((m) => m.text.trim())
    .map((m) => ({
      id: `managed-${m.id}`,
      kind: 'message',
      role: m.role,
      text: m.text,
      messageId: m.id
    }))
}

export function upsertTimelineItem(
  items: ManagedChatTimelineItem[],
  next: ManagedChatTimelineItem
): ManagedChatTimelineItem[] {
  const index = items.findIndex((item) => item.id === next.id)
  const merged = index === -1 ? [...items, next] : [...items.slice(0, index), next, ...items.slice(index + 1)]
  return merged.sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
}

export function timelineItems(
  messages: ManagedChatMessage[],
  timeline: ManagedChatTimelineItem[],
  status: ChatTurnStatus = 'idle'
): ChatItem[] {
  if (timeline.length === 0) return managedItems(messages)

  const turns = groupTimelineByTurn(timeline)
  // assistant 消息按 createdAt 排序，仅用于把「聚合回复」关联到持久化 messageId（收藏/标注）。
  // 渲染顺序不再依赖此配对——顺序由下面 user / turn 的 createdAt 合并排序决定。
  const assistants = messages
    .filter((message) => message.role === 'assistant' && message.text.trim())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const usedAssistants = new Set<string>()

  // 渲染单元：user 消息（取服务端顺序）与 turn（process + 回答），各自带 createdAt。
  // 稳定合并排序后即得正确交错——user 永远落在它自己的时间位，不再被「尾部兜底」沉到底，
  // 也避免「按下标把 user 配到错误的 turn」（修 Bug：输出期间/刚结束就再发一条，
  // 或出现孤儿 user 时，提问被渲染到自己回答的下方）。
  type RenderUnit =
    | { kind: 'user'; message: ManagedChatMessage; at: string }
    | {
        kind: 'turn'
        turnId: string
        items: ManagedChatTimelineItem[]
        assistantId?: string
        at: string
      }
  const units: RenderUnit[] = []
  for (const message of messages) {
    if (message.role === 'user' && message.text.trim()) {
      units.push({ kind: 'user', message, at: message.createdAt })
    }
  }
  turns.forEach((turn, index) => {
    const assistant = assistants[index]
    if (assistant) usedAssistants.add(assistant.id)
    units.push({
      kind: 'turn',
      turnId: turn.turnId,
      items: turn.items,
      ...(assistant ? { assistantId: assistant.id } : {}),
      // turn 内 items 已按 seq 升序，首个即最早。
      at: turn.items[0]?.createdAt ?? ''
    })
  })

  units.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))

  const result: ChatItem[] = []
  for (const unit of units) {
    if (unit.kind === 'user') {
      result.push({
        id: `managed-${unit.message.id}`,
        kind: 'message',
        role: 'user',
        text: unit.message.text,
        messageId: unit.message.id
      })
      continue
    }
    const process = processItemFromTimeline(unit.items, status)
    if (process) result.push(process)
    const text = unit.items
      .filter((item) => item.type === 'text' && item.content)
      .map((item) => item.content)
      .join('')
      .trim()
    if (text) {
      result.push({
        id: `timeline-answer-${unit.turnId}`,
        kind: 'message',
        role: 'assistant',
        text,
        // 关联持久化的 assistant 消息 id，使聚合回复也可收藏/打标签。
        ...(unit.assistantId ? { messageId: unit.assistantId } : {})
      })
    } else if (unit.assistantId) {
      // turn 暂无文本项（刚启动/仅工具调用）：回退到持久化 assistant 消息文本（为空则跳过）。
      const assistant = assistants.find((message) => message.id === unit.assistantId)
      if (assistant?.text.trim()) {
        result.push({
          id: `managed-${assistant.id}`,
          kind: 'message',
          role: 'assistant',
          text: assistant.text,
          messageId: assistant.id
        })
      }
    }
  }

  // 兜底：未被任何 turn 消费的 assistant 消息（历史/部分加载等罕见情形）放末尾。
  // 注意 user 消息不走兜底——它们已在上面合并排序中就位，这是修复「提问沉到底」的关键。
  for (const assistant of assistants) {
    if (usedAssistants.has(assistant.id)) continue
    result.push({
      id: `managed-${assistant.id}`,
      kind: 'message',
      role: 'assistant',
      text: assistant.text,
      messageId: assistant.id
    })
  }

  return result
}

export function processStatusText(
  timeline: ManagedChatTimelineItem[],
  status: ChatTurnStatus = 'idle'
): string {
  if (status === 'awaiting-permission') return tr('chat.status.awaitingConfirmation')
  if (status === 'failed') return tr('chat.status.failed')
  if (status === 'interrupted') return tr('chat.status.interrupted')
  const latest = [...timeline].sort((a, b) => b.seq - a.seq)[0]
  if (!latest) return status === 'running' ? tr('chat.status.starting') : tr('chat.status.idle')
  if (status !== 'running') return ''
  if (latest.type === 'thinking') return tr('chat.status.thinking')
  if (latest.type === 'text') return tr('chat.status.replying')
  if (latest.type === 'error') return tr('chat.status.failed')
  if (latest.type === 'permission') return latest.status === 'pending' ? tr('chat.status.awaitingConfirmation') : tr('chat.status.continuing')
  if (latest.type === 'tool_use') return toolActionText(latest.tool, latest.input)
  if (latest.type === 'tool_result') return latest.isError ? tr('chat.status.toolFailed') : tr('chat.status.toolDone')
  return status === 'running' ? tr('chat.status.working') : tr('chat.status.idle')
}

export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const object = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'filePath', 'path', 'pattern', 'url', 'description']) {
    const value = object[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

export function compactOutput(value: string | undefined, max = 1_800): string {
  if (!value) return ''
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n${tr('chat.compact.truncatedSuffix', { count: value.length - max })}`
}

export function applyAgentEvent(items: ChatItem[], event: AgentEvent, id: string): ChatItem[] {
  if (event.kind === 'thinking-delta') {
    const last = items.at(-1)
    if (last?.kind === 'thinking') {
      return [...items.slice(0, -1), { ...last, text: `${last.text}${event.text}` }]
    }
    return [...items, { id, kind: 'thinking', text: event.text }]
  }
  if (event.kind === 'text-delta') {
    const last = items.at(-1)
    if (last?.kind === 'message' && last.role === 'assistant') {
      return [...items.slice(0, -1), { ...last, text: `${last.text}${event.text}` }]
    }
    return [...items, { id, kind: 'message', role: 'assistant', text: event.text }]
  }
  if (event.kind === 'tool-start') {
    return [
      ...items,
      {
        id,
        kind: 'tool',
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input
      }
    ]
  }
  if (event.kind === 'tool-result') {
    return items.map((item) =>
      item.kind === 'tool' && item.toolUseId === event.toolUseId
        ? { ...item, result: event.content, isError: event.isError }
        : item
    )
  }
  if (event.kind === 'permission-request') {
    return [
      ...items.filter((item) => item.kind !== 'permission' || item.requestId !== event.requestId),
      {
        id,
        kind: 'permission',
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input
      }
    ]
  }
  if (event.kind === 'error' && !event.retryable) {
    return [...items, { id, kind: 'message', role: 'system', text: event.message }]
  }
  if (event.kind === 'unknown') {
    return [
      ...items,
      {
        id,
        kind: 'unknown',
        rawType: event.rawType,
        payload: event.payload
      }
    ]
  }
  return items
}

function groupTimelineByTurn(
  timeline: ManagedChatTimelineItem[]
): Array<{ turnId: string; items: ManagedChatTimelineItem[] }> {
  const groups = new Map<string, ManagedChatTimelineItem[]>()
  for (const item of [...timeline].sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))) {
    const items = groups.get(item.turnId) ?? []
    items.push(item)
    groups.set(item.turnId, items)
  }
  return [...groups.entries()].map(([turnId, items]) => ({ turnId, items }))
}

function processItemFromTimeline(
  items: ManagedChatTimelineItem[],
  status: ChatTurnStatus
): Extract<ChatItem, { kind: 'process' }> | null {
  const steps: ProcessStep[] = []
  const toolUses = new Map<string, ManagedChatTimelineItem>()

  for (const item of items) {
    if (item.type === 'tool_use' && item.toolUseId) {
      toolUses.set(item.toolUseId, item)
    }
  }

  for (const item of items) {
    if (item.type === 'thinking' && item.content) {
      const previous = steps.at(-1)
      if (previous?.kind === 'thinking') {
        previous.detail = `${previous.detail ?? ''}${item.content}`
      } else {
        steps.push({
          id: item.id,
          kind: 'thinking',
          title: tr('chat.process.thinkingTitle'),
          detail: item.content,
          createdAt: item.createdAt
        })
      }
    }
    if (item.type === 'tool_use') {
      steps.push({
        id: item.id,
        kind: 'tool',
        title: toolActionText(item.tool, item.input),
        detail: toolSummary(item.input),
        tool: item.tool,
        input: item.input,
        createdAt: item.createdAt
      })
    }
    if (item.type === 'tool_result') {
      const existing = [...steps]
        .reverse()
        .find((step) => step.kind === 'tool' && item.toolUseId && step.id === toolUses.get(item.toolUseId)?.id)
      if (existing) {
        existing.output = item.output
        existing.isError = item.isError
      } else {
        steps.push({
          id: item.id,
          kind: 'tool',
          title: item.isError ? tr('chat.status.toolFailed') : tr('chat.status.toolDone'),
          detail: item.toolUseId,
          tool: item.tool,
          output: item.output,
          isError: item.isError,
          createdAt: item.createdAt
        })
      }
    }
    if (item.type === 'permission') {
      steps.push({
        id: item.id,
        kind: 'permission',
        title: permissionTitle(item.status),
        detail: toolSummary(item.input),
        tool: item.tool,
        input: item.input,
        status: item.status,
        createdAt: item.createdAt
      })
    }
    if (item.type === 'error') {
      steps.push({
        id: item.id,
        kind: 'error',
        title: tr('chat.status.failed'),
        detail: item.content,
        isError: true,
        createdAt: item.createdAt
      })
    }
  }

  if (steps.length === 0) return null
  const latest = items.at(-1)
  const running = status === 'running' || status === 'awaiting-permission'
  return {
    id: `process-${items[0].turnId}`,
    kind: 'process',
    turnId: items[0].turnId,
    title: latest ? processStatusText(items, status) : tr('chat.process.runTitle'),
    status:
      status === 'awaiting-permission'
        ? 'awaiting'
        : steps.some((step) => step.isError)
          ? 'failed'
          : running
            ? 'running'
            : 'completed',
    defaultOpen: running,
    steps
  }
}

function permissionTitle(status: ManagedChatPermissionStatus | undefined): string {
  if (status === 'allowed-once') return tr('chat.permission.allowedOnce')
  if (status === 'allowed-always') return tr('chat.permission.allowedAlways')
  if (status === 'denied') return tr('chat.permission.denied')
  return tr('chat.status.awaitingConfirmation')
}

function shouldHideTranscriptMessage(message: NormalizedMessage, text: string): boolean {
  if (text.includes('<local-command-caveat>')) return true
  if (/^\[unsupported:\s*[\w.-]+\]$/i.test(text)) return true
  return message.role === 'system' && text === '系统'
}

function transcriptProcessStep(message: NormalizedMessage, text: string): ProcessStep | null {
  const rawKind = message.raw?.kind
  const createdAt = message.ts ?? ''
  const id = `history-${message.seq}`

  if (rawKind === 'thinking' || rawKind === 'reasoning') {
    return {
      id,
      kind: 'thinking',
      title: tr('chat.process.thinkingTitle'),
      detail: text,
      createdAt
    }
  }

  if (text.includes('<command-name>') || text.includes('<command-message>') || text.includes('<command-args>')) {
    const name = extractTag(text, 'command-name')
    const messageText = extractTag(text, 'command-message')
    const args = extractTag(text, 'command-args')
    return {
      id,
      kind: 'tool',
      title: name ? tr('chat.step.localCommand', { name }) : tr('chat.step.localCommandShort'),
      detail: [messageText, args].filter(Boolean).join('\n') || undefined,
      tool: name ?? 'local-command',
      createdAt
    }
  }

  if (text.includes('<local-command-stdout>')) {
    return {
      id,
      kind: 'tool',
      title: tr('chat.step.localCommandOutput'),
      output: compactOutput(extractTag(text, 'local-command-stdout') ?? text),
      tool: 'local-command',
      createdAt
    }
  }

  if (message.role === 'tool') {
    const tool = message.toolName ?? 'tool'
    const isResult = rawKind === 'tool_result' || rawKind === 'function_call_output' || rawKind === 'custom_tool_call_output'
    return {
      id,
      kind: 'tool',
      title: isResult ? tr('chat.step.toolResult') : tr('chat.step.toolCall', { tool }),
      detail: isResult ? undefined : text,
      output: isResult ? compactOutput(text) : undefined,
      tool,
      createdAt
    }
  }

  if (message.role === 'system') {
    return {
      id,
      kind: 'tool',
      title: tr('chat.step.systemEvent'),
      detail: text,
      tool: rawKind ?? 'system',
      createdAt
    }
  }

  return null
}

function extractTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))
  const value = match?.[1]?.trim()
  return value || undefined
}

function toolActionText(tool: string | undefined, input: unknown): string {
  const name = tool ?? tr('chat.tool.default')
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('command')) return tr('chat.tool.runningCommand')
  if (lower.includes('grep')) return tr('chat.tool.searchingCode')
  if (lower.includes('glob')) return tr('chat.tool.matchingFiles')
  if (lower.includes('read')) return tr('chat.tool.readingFile')
  if (lower.includes('write') || lower.includes('edit') || lower.includes('patch')) return tr('chat.tool.editingFile')
  if (typeof input === 'object' && input) {
    const summary = toolSummary(input)
    if (/https?:\/\//i.test(summary)) return tr('chat.tool.visitingPage')
  }
  return tr('chat.tool.calling', { name })
}
