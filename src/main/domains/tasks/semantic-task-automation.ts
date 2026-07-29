import type { ChatTurnState, ManagedChatMessage } from '@shared/types'
import type { RuntimeHost } from '../runtime/protocol'
import {
  parseSemanticTaskFollowUp,
  parseSemanticTaskIntent,
  type ParseOptions,
  type SemanticTaskIntent
} from './semantic-schedule'

type SemanticAutomationRuntime = Pick<
  RuntimeHost,
  'sendTurn' | 'listSessionViews' | 'createTask' | 'chatHistory'
>

const FOLLOW_UP_WINDOW_MS = 30 * 60 * 1000
const TASK_CONTEXT_TOKEN = /(?:任务|定时|计划|执行时间|一次性执行|具体任务内容)/u

export function semanticTaskFollowUpFromHistory(
  text: string,
  history: ManagedChatMessage[],
  options: ParseOptions = {}
): SemanticTaskIntent | null {
  const normalized = text.trim()
  const currentIndex = history.findLastIndex(
    (message) => message.role === 'user' && message.text.trim() === normalized
  )
  if (currentIndex < 0) return null
  const lastUserIndex = history.findLastIndex((message) => message.role === 'user')
  if (currentIndex !== lastUserIndex) return null

  let previousUserIndex = currentIndex - 1
  while (previousUserIndex >= 0 && history[previousUserIndex].role !== 'user') {
    previousUserIndex -= 1
  }
  if (previousUserIndex < 0) return null

  const previous = history[previousUserIndex]
  const current = history[currentIndex]
  const previousAt = Date.parse(previous.createdAt)
  const currentAt = Date.parse(current.createdAt)
  if (
    !Number.isFinite(previousAt) ||
    !Number.isFinite(currentAt) ||
    currentAt < previousAt ||
    currentAt - previousAt > FOLLOW_UP_WINDOW_MS
  ) {
    return null
  }

  const assistantConfirmedContext = history
    .slice(previousUserIndex + 1, currentIndex)
    .some(
      (message) =>
        message.role === 'assistant' &&
        message.status === 'completed' &&
        TASK_CONTEXT_TOKEN.test(message.text)
    )
  if (!assistantConfirmedContext) return null
  return parseSemanticTaskFollowUp(previous.text, current.text, options)
}

/**
 * 先让原对话进入 Runtime；只有发送被接受后才尝试创建任务。
 * 自动化失败会作为可见元数据返回，不会吞掉或重发用户原话。
 */
export async function sendTurnWithSemanticAutomation(
  runtime: SemanticAutomationRuntime,
  sessionId: string,
  text: string,
  files?: string[]
): Promise<ChatTurnState> {
  const state = await runtime.sendTurn(sessionId, text, files)
  let intent = parseSemanticTaskIntent(text)
  if (!intent) {
    try {
      intent = semanticTaskFollowUpFromHistory(text, await runtime.chatHistory(sessionId))
    } catch {
      // History is an optional enhancement for a follow-up turn; ordinary chat must still proceed.
    }
  }
  if (!intent) return state

  try {
    const session = (await runtime.listSessionViews()).find((item) => item.id === sessionId)
    if (!session) throw new Error('当前会话不存在，无法创建定时任务')
    if (!session.workspacePath.trim()) throw new Error('当前会话没有工作目录，无法创建定时任务')
    const task = await runtime.createTask({
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
    return {
      ...state,
      taskAutomation: {
        status: 'created',
        taskId: task.id,
        title: task.title,
        ...(task.schedule?.nextRunAt ? { nextRunAt: task.schedule.nextRunAt } : {})
      }
    }
  } catch (error) {
    return {
      ...state,
      taskAutomation: {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
