// 构建一个 InProcessRuntimeHost（含 sessions / chatStore / chat / provider / terminal）。
// 本地 daemon（daemon.ts）与远程节点（remote-node.ts）共用此装配逻辑，避免重复。

import { dirname, join } from 'node:path'
import { FileSessionRepository } from '../sessions/file-repository'
import { ChatSqliteStore } from '../sessions/chat-sqlite-store'
import { TerminalManager } from '../terminal/manager'
import { createInProcessRuntimeHost } from './create-in-process-runtime-host'
import { createFileProviderConfig } from './provider-file'
import { ChatManager } from '../chat/manager'
import { getAdapter } from '../adapters/registry'
import { backfillManagedNativeSessions } from '../sessions/native-session-binding'
import type { InProcessRuntimeHost } from './in-process-runtime-host'
import { runtimeBuildIdFor } from './daemon-config'
import type { DaemonConfig } from './daemon-config'
import { TaskRepository } from '../tasks/repository'
import { TaskService } from '../tasks/service'

export interface DaemonRuntimeBundle {
  runtime: InProcessRuntimeHost
  chat: ChatManager
  chatStore: ChatSqliteStore
  tasks: TaskService
  runtimeBuildId: string
}

/**
 * 按 DaemonConfig 装配出一套就绪的 InProcessRuntimeHost。
 * 不负责启动 RPC server，也不写 daemon.json——这些由各入口（本地/远程）自行决定。
 */
export async function createDaemonRuntime(config: DaemonConfig): Promise<DaemonRuntimeBundle> {
  const sessions = new FileSessionRepository(config.sessionsFile)
  const chatStore = new ChatSqliteStore(
    config.chatStoreFile || join(dirname(config.sessionsFile), 'chat-store.sqlite')
  )
  sessions.clearTerminalBindings()
  sessions.markInterruptedChatMessages()
  chatStore.markInterruptedMessages()
  await backfillManagedNativeSessions({
    sessions: sessions.listSessions(),
    getAdapter,
    bindNativeSession: (id, nativeSessionId) => sessions.bindNativeSession(id, nativeSessionId)
  })
  const terminal = new TerminalManager(() => undefined)
  const provider = createFileProviderConfig(config.providerStoreFile)
  let runtime: InProcessRuntimeHost | null = null
  const taskRepository = new TaskRepository(
    config.tasksFile || join(dirname(config.sessionsFile), 'tasks.json')
  )
  const tasks = new TaskService({
    repository: taskRepository,
    runtime: () => {
      if (!runtime) throw new Error('Runtime Host 尚未就绪')
      return runtime
    },
    emit: (event) => runtime?.emitTaskChanged(event)
  })
  const chat = await ChatManager.create({
    approvalToken: config.token,
    getSession: (id) => sessions.getSession(id),
    bindNativeSession: (id, nativeSessionId) => sessions.bindNativeSession(id, nativeSessionId),
    listChatHistory: (id) => {
      const messages = chatStore.listMessages(id)
      return messages.length > 0 ? messages : sessions.listChatHistory(id)
    },
    appendChatMessage: (id, message) => chatStore.appendMessage(id, message),
    updateChatMessage: (id, messageId, patch) => chatStore.updateMessage(id, messageId, patch),
    listTimeline: (id) => chatStore.listTimeline(id),
    appendTimelineItem: (item) => chatStore.appendTimelineItem(item),
    listQueuedTurns: (id) => chatStore.listQueuedTurns(id),
    enqueueTurn: (id, input) => chatStore.enqueueTurn(id, input),
    cancelQueuedTurn: (id, queuedTurnId) => chatStore.cancelQueuedTurn(id, queuedTurnId),
    updatePermissionStatus: (sessionId, turnId, toolUseId, status) =>
      chatStore.updatePermissionStatus(sessionId, turnId, toolUseId, status),
    nextTimelineSeq: (sessionId) => chatStore.nextSeq(sessionId),
    getAdapter,
    getProviderEnv: (toolId) => provider.environment(toolId),
    getProviderModel: (toolId) => provider.model(toolId),
    emit: (sessionId, event, timelineItem, turnId) =>
      runtime?.emitAgentEvent(sessionId, event, timelineItem, turnId)
  })
  const runtimeBuildId = runtimeBuildIdFor(process.argv[1] ?? '', config.runtimeBuildId)
  runtime = createInProcessRuntimeHost(
    terminal,
    config.hostVersion,
    sessions,
    chat,
    provider,
    runtimeBuildId,
    tasks
  )
  tasks.start()
  return { runtime, chat, chatStore, tasks, runtimeBuildId }
}
