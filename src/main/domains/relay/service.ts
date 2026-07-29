import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ManagedChatMessage,
  NormalizedTranscript,
  RelayContextReport,
  RelayTarget,
  RuntimeHost,
  RuntimeInfo,
  SessionRelayRef,
  StartRelayPayload,
  StartRelayResult,
  WorkbenchSession
} from '@shared/types'
import { buildRelayContextMarkdown, sortRelayTargets } from './context'
import { relayTitle } from './title'

interface RelayServiceOptions {
  runtime: RuntimeHost
  getTranscript(sessionId: string): Promise<NormalizedTranscript | null>
  openRepair(toolId: string): Promise<void>
  getGitSummary?(workspacePath: string): string
}

function displayNameOf(runtime: RuntimeInfo): string {
  return runtime.displayName || runtime.toolId
}

function hostIdOf(runtime: RuntimeInfo): string {
  return runtime.runtimeHostId ?? 'local'
}

function availabilityOf(runtime: RuntimeInfo): RelayTarget['availability'] {
  if (runtime.health === 'ready' || runtime.health === 'updatable') {
    return runtime.capabilities.chat ? 'available' : 'unavailable'
  }
  if (runtime.health === 'missing') return 'not-installed'
  return 'not-authenticated'
}

function reasonOf(target: RelayTarget): string | undefined {
  if (target.reason) return target.reason
  if (target.availability === 'not-installed') return '未安装'
  if (target.availability === 'not-authenticated') return '未登录或授权不可用'
  if (target.availability === 'unavailable') return '暂不支持会话镜头'
  return undefined
}

function recentMessages(messages: ManagedChatMessage[]): string[] {
  return messages
    .filter((message) => message.text.trim())
    .slice(-8)
    .map((message) => `${message.role === 'user' ? '用户' : 'Agent'}：${message.text.trim().slice(0, 500)}`)
}

function transcriptPath(session: WorkbenchSession): string | null {
  return session.nativeSessionId ? `${session.toolId}:${session.nativeSessionId}` : null
}

function defaultGitSummary(workspacePath: string): string {
  try {
    const status = execFileSync('git', ['-C', workspacePath, 'status', '--short'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    const stat = execFileSync('git', ['-C', workspacePath, 'diff', '--stat'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return [status, stat].filter(Boolean).join('\n') || '（工作区无未提交改动）'
  } catch {
    return '（无法读取 git diff 摘要）'
  }
}

export class RelayService {
  constructor(private readonly options: RelayServiceOptions) {}

  async listTargets(sourceSessionId: string): Promise<RelayTarget[]> {
    const [sessions, runtimes] = await Promise.all([
      this.options.runtime.listSessions(),
      this.options.runtime.listRuntimes()
    ])
    const source = sessions.find((session) => session.id === sourceSessionId)
    // 历史/记忆来源：source 不在活跃会话里时回退 transcript 索引，拿来源 toolId 用于过滤来源 Agent 自身。
    const sourceToolId =
      source?.toolId ?? (await this.options.getTranscript(sourceSessionId).catch(() => null))?.toolId
    const lastUsed = new Map<string, string>()
    for (const session of sessions) {
      const key = `${session.runtimeHostId ?? 'local'}/${session.toolId}`
      const current = lastUsed.get(key)
      if (!current || session.updatedAt > current) lastUsed.set(key, session.updatedAt)
    }
    const sourceHostId = source?.runtimeHostId ?? 'local'
    return sortRelayTargets(
      runtimes
        .filter((runtime) => !(sourceToolId && runtime.toolId === sourceToolId && hostIdOf(runtime) === sourceHostId))
        .map((runtime) => {
          const hostId = hostIdOf(runtime)
          const lastUsedAt = lastUsed.get(`${hostId}/${runtime.toolId}`)
          const target: RelayTarget = {
            toolId: runtime.toolId,
            displayName: displayNameOf(runtime),
            availability: availabilityOf(runtime),
            ...(hostId !== 'local' ? { runtimeHostId: hostId } : {}),
            ...(runtime.version ? { version: runtime.version } : {}),
            ...(lastUsedAt ? { lastUsedAt } : {})
          }
          return { ...target, ...(reasonOf(target) ? { reason: reasonOf(target) } : {}) }
        })
    )
  }

  async start(payload: StartRelayPayload): Promise<StartRelayResult> {
    const sessions = await this.options.runtime.listSessions()
    let source = sessions.find(
      (session) => session.id === payload.sourceSessionId
    )
    if (!source && payload.sourceSurface === 'history') {
      const transcript = await this.options.getTranscript(payload.sourceSessionId)
      if (transcript) {
        const timestamp = transcript.lastActivityAt ?? transcript.startedAt ?? new Date().toISOString()
        source = {
          id: payload.sourceSessionId,
          name: transcript.title,
          toolId: transcript.toolId,
          workspacePath: transcript.cwd ?? '',
          terminalSessionId: null,
          nativeSessionId: transcript.nativeSessionId,
          surface: 'chat',
          permissionPreset: 'safe',
          favorite: false,
          pinned: false,
          createdAt: transcript.startedAt ?? timestamp,
          updatedAt: timestamp
        }
      }
    }
    if (!source) throw new Error('来源会话不存在')

    const target = (await this.listTargets(source.id)).find(
      (item) =>
        item.toolId === payload.targetToolId &&
        (item.runtimeHostId ?? 'local') === (payload.targetRuntimeHostId ?? 'local')
    )
    if (!target) throw new Error('目标 Agent 不存在')
    if (target.availability !== 'available') {
      throw new Error(target.reason ?? '目标 Agent 暂不可接力')
    }

    const linkId = randomUUID()
    const rootTitle = source.rootTitle ?? source.name.replace(/\s*\/\s*[^/]+接力\s*$/u, '')
    const contextPackPath = this.contextPath(source.workspacePath, linkId)
    const context = await this.buildContext(source, payload, contextPackPath)
    writeFileSync(contextPackPath, context, 'utf8')

    const targetHandle = await this.options.runtime.createSession({
      name: relayTitle(source.name, target.displayName, rootTitle),
      toolId: payload.targetToolId,
      workspacePath: source.workspacePath,
      surface: 'chat',
      permissionPreset: source.permissionPreset,
      ...(payload.targetModel ? { model: payload.targetModel } : {}),
      ...(payload.targetRuntimeHostId && payload.targetRuntimeHostId !== 'local'
        ? { runtimeHostId: payload.targetRuntimeHostId }
        : {}),
      rootTitle,
      relaySource: {
        linkId,
        sessionId: source.id,
        toolId: source.toolId,
        title: source.name,
        contextPackPath
      }
    })
    const targetSession = targetHandle.session
    try {
      await this.options.runtime.sendTurn(targetSession.id, context)
      const sourceRef: SessionRelayRef = {
        linkId,
        sessionId: source.id,
        toolId: source.toolId,
        title: source.name,
        contextPackPath
      }
      const targetRef: SessionRelayRef = {
        linkId,
        sessionId: targetSession.id,
        toolId: targetSession.toolId,
        title: targetSession.name,
        contextPackPath
      }
      if (sessions.some((session) => session.id === source.id)) {
        await this.options.runtime.updateSession(source.id, { relayTarget: targetRef, rootTitle })
      }
      await this.options.runtime.updateSession(targetSession.id, { relaySource: sourceRef, rootTitle })
      return { targetSessionId: targetSession.id, relayLinkId: linkId }
    } catch (error) {
      await this.options.runtime.removeSession(targetSession.id).catch(() => undefined)
      throw error
    }
  }

  async getContextReport(linkId: string): Promise<RelayContextReport | null> {
    const sessions = await this.options.runtime.listSessions()
    const ref = sessions
      .flatMap((session) => [session.relaySource, session.relayTarget])
      .find((item): item is SessionRelayRef => Boolean(item && item.linkId === linkId))
    if (!ref?.contextPackPath) return null
    try {
      return {
        linkId,
        markdown: readFileSync(ref.contextPackPath, 'utf8'),
        contextPackPath: ref.contextPackPath
      }
    } catch {
      return null
    }
  }

  async getLink(sessionId: string): Promise<{ source?: SessionRelayRef; target?: SessionRelayRef }> {
    const session = (await this.options.runtime.listSessions()).find((item) => item.id === sessionId)
    return {
      ...(session?.relaySource ? { source: session.relaySource } : {}),
      ...(session?.relayTarget ? { target: session.relayTarget } : {})
    }
  }

  openRepair(toolId: string): Promise<void> {
    return this.options.openRepair(toolId)
  }

  private contextPath(workspacePath: string, linkId: string): string {
    const dir = join(workspacePath, '.agent-os')
    mkdirSync(dir, { recursive: true })
    return join(dir, `relay-context-${linkId}.md`)
  }

  private async buildContext(
    source: WorkbenchSession,
    payload: StartRelayPayload,
    contextPackPath: string
  ): Promise<string> {
    const [history, transcript, terminalHistory] = await Promise.all([
      this.options.runtime.chatHistory(source.id).catch(() => [] as ManagedChatMessage[]),
      transcriptPath(source)
        ? this.options.getTranscript(transcriptPath(source)!).catch(() => null)
        : Promise.resolve(null),
      source.terminalSessionId
        ? this.options.runtime.history(source.terminalSessionId).catch(() => '')
        : Promise.resolve('')
    ])
    const transcriptMessages = transcript?.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-8)
      .map((message) => `${message.role === 'user' ? '用户' : 'Agent'}：${message.text.trim().slice(0, 500)}`) ?? []
    const messages = recentMessages(history)
    return buildRelayContextMarkdown({
      sourceTitle: source.name,
      sourceToolId: source.toolId,
      targetToolId: payload.targetToolId,
      workspacePath: source.workspacePath,
      sourceSessionId: source.id,
      sourceNativeSessionId: source.nativeSessionId,
      recentMessages: messages.length > 0 ? messages : transcriptMessages,
      terminalHistory,
      transcriptPath: transcriptPath(source) ?? contextPackPath,
      gitSummary: (this.options.getGitSummary ?? defaultGitSummary)(source.workspacePath)
    })
  }
}
