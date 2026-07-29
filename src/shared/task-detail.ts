import type {
  ManagedChatMessage,
  ManagedChatTimelineItem,
  TaskRun,
  WorkbenchSessionView
} from './types'

function timeOf(value?: string): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function belongsToRun(createdAt: string, run: TaskRun | null): boolean {
  if (!run) return true
  const created = timeOf(createdAt)
  if (created === null) return false
  const started = timeOf(run.startedAt)
  const finished = timeOf(run.finishedAt)
  if (started !== null && created < started) return false
  if (finished !== null && created > finished) return false
  return true
}

function isStreamDelta(item: ManagedChatTimelineItem): boolean {
  return item.type === 'thinking' || item.type === 'text'
}

function coalesceStreamDeltas(
  items: readonly ManagedChatTimelineItem[]
): ManagedChatTimelineItem[] {
  return items.reduce<ManagedChatTimelineItem[]>((merged, item) => {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      isStreamDelta(previous) &&
      previous.type === item.type &&
      previous.sessionId === item.sessionId &&
      previous.turnId === item.turnId
    ) {
      merged[merged.length - 1] = {
        ...previous,
        content: `${previous.content ?? ''}${item.content ?? ''}`
      }
      return merged
    }
    merged.push(item)
    return merged
  }, [])
}

export function findTaskSessionView(
  sessionId: string,
  views: readonly WorkbenchSessionView[]
): WorkbenchSessionView | null {
  return views.find((view) => view.id === sessionId) ?? null
}

export function taskTimelineForRun(
  run: TaskRun | null,
  timeline: readonly ManagedChatTimelineItem[]
): ManagedChatTimelineItem[] {
  return coalesceStreamDeltas(
    timeline
      .filter(
        (item) =>
          (!run?.sessionId || item.sessionId === run.sessionId) && belongsToRun(item.createdAt, run)
      )
      .sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
  )
}

export function taskMessagesForRun(
  run: TaskRun | null,
  messages: readonly ManagedChatMessage[]
): ManagedChatMessage[] {
  return messages
    .filter((message) => belongsToRun(message.createdAt, run))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export interface TaskDeliveryView {
  id: string
  text: string
  status: ManagedChatMessage['status']
  createdAt: string
  source: 'history' | 'timeline'
}

export function taskDeliveriesForRun(
  run: TaskRun | null,
  messages: readonly ManagedChatMessage[],
  timeline: readonly ManagedChatTimelineItem[]
): TaskDeliveryView[] {
  const assistantMessages = taskMessagesForRun(run, messages).filter(
    (message) => message.role === 'assistant' && message.text.trim()
  )
  if (assistantMessages.length > 0) {
    const message = assistantMessages[assistantMessages.length - 1]
    return [
      {
        id: message.id,
        text: message.text,
        status: message.status,
        createdAt: message.updatedAt || message.createdAt,
        source: 'history'
      }
    ]
  }

  const textItems = taskTimelineForRun(run, timeline).filter(
    (item) => item.type === 'text' && item.content?.trim()
  )
  const item = textItems[textItems.length - 1]
  if (!item?.content) return []
  return [
    {
      id: item.id,
      text: item.content,
      status:
        run && ['queued', 'running', 'needs_attention'].includes(run.status)
          ? 'streaming'
          : 'completed',
      createdAt: item.createdAt,
      source: 'timeline'
    }
  ]
}
