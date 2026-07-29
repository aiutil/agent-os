// 会话视图模型构建（SPEC-005）。纯函数，便于单测。
// 合并「持久化会话元数据」与「实时终端状态」，并按工作目录分组。

import path from 'node:path'
import type {
  TerminalRunState,
  WorkbenchSession,
  WorkbenchSessionView,
  SessionProjectGroup
} from '@shared/types'

/** PATH basename 作为项目名；根目录回退为完整路径。 */
export function projectNameOf(workspacePath: string): string {
  const base = path.basename(workspacePath || '')
  return base || workspacePath || '未命名项目'
}

/** 合并单个会话与其实时状态。无活跃终端状态时标记 disconnected。 */
export function buildSessionView(
  session: WorkbenchSession,
  state: TerminalRunState | null,
  canResume = false
): WorkbenchSessionView {
  const mode = session.mode ?? (session.surface === 'chat' ? 'chat' : 'cli')
  const continuity = !canResume
    ? { state: 'unsupported' as const, reason: '此 CLI 暂不支持在对话中关联终端' }
    : session.nativeSessionId
      ? { state: 'ready' as const }
      : state && mode === 'cli'
        ? { state: 'binding' as const, reason: '正在建立终端关联…' }
        : { state: 'missing' as const, reason: '发送一条消息后即可关联终端' }
  return {
    ...session,
    terminalSessionId: state ? session.terminalSessionId : null,
    status:
      state?.status ??
      (mode === 'cli' && continuity.state === 'ready' ? 'resumable' : 'disconnected'),
    outputTail: state?.outputTail ?? '',
    lastActivityAt: state?.lastActivityAt ?? session.updatedAt,
    continuity
  }
}

export function sortSessionViews(views: WorkbenchSessionView[]): WorkbenchSessionView[] {
  return [...views].sort((a, b) => {
    const pinDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    if (pinDelta !== 0) return pinDelta
    const timeDelta = (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
    if (timeDelta !== 0) return timeDelta
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  })
}

export function buildSessionViews(
  sessions: WorkbenchSession[],
  states: TerminalRunState[],
  canResumeTool: (toolId: string) => boolean = () => false
): WorkbenchSessionView[] {
  const byId = new Map(states.map((state) => [state.sessionId, state]))
  return sortSessionViews(
    sessions
      .filter((session) => !session.archivedAt)
      .map((session) =>
        buildSessionView(
          session,
          session.terminalSessionId ? byId.get(session.terminalSessionId) ?? null : null,
          canResumeTool(session.toolId)
        )
      )
  )
}

/** 按工作目录分组，组内和分组均按最近活跃时间倒序。SPEC-031：稳定排序。 */
export function groupByProject(views: WorkbenchSessionView[]): SessionProjectGroup[] {
  const groups = new Map<string, WorkbenchSessionView[]>()
  for (const view of views) {
    const list = groups.get(view.workspacePath) ?? []
    list.push(view)
    groups.set(view.workspacePath, list)
  }

  const result: SessionProjectGroup[] = []
  for (const [workspacePath, list] of groups) {
    result.push({ workspacePath, projectName: projectNameOf(workspacePath), sessions: sortSessionViews(list) })
  }
  result.sort((a, b) => {
    const aLatest = a.sessions[0]?.lastActivityAt ?? ''
    const bLatest = b.sessions[0]?.lastActivityAt ?? ''
    return bLatest.localeCompare(aLatest)
  })
  return result
}
