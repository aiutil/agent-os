import type { RelayTarget } from '@shared/types'

export interface RelayContextInput {
  sourceTitle: string
  sourceToolId: string
  targetToolId: string
  workspacePath: string | null
  sourceSessionId: string
  sourceNativeSessionId?: string | null
  recentMessages: string[]
  terminalHistory?: string
  transcriptPath?: string | null
  gitSummary?: string
}

function availabilityRank(target: RelayTarget): number {
  return target.availability === 'available' ? 0 : 1
}

export function sortRelayTargets(targets: RelayTarget[]): RelayTarget[] {
  return [...targets].sort((a, b) => {
    const byAvailability = availabilityRank(a) - availabilityRank(b)
    if (byAvailability !== 0) return byAvailability
    if (a.availability === 'available' && b.availability === 'available') {
      return (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '')
    }
    return a.displayName.localeCompare(b.displayName)
  })
}

function section(title: string, body: string): string[] {
  return [`## ${title}`, '', body.trim() || '（无）', '']
}

export function buildRelayContextMarkdown(input: RelayContextInput): string {
  const recent = input.recentMessages.length > 0
    ? input.recentMessages.map((line) => `- ${line.trim()}`).join('\n')
    : '（没有可用的最近对话）'
  const terminal = input.terminalHistory?.trim()
    ? input.terminalHistory.trim().slice(-4000)
    : '（没有可用的终端历史）'
  const lines = [
    '# 接力上下文包',
    '',
    `你正在从 ${input.sourceToolId} 接手这个任务。请先阅读以下上下文，再继续工作。`,
    '',
    ...section(
      '会话元信息',
      [
        `- 来源会话：${input.sourceTitle}`,
        `- 来源 Agent：${input.sourceToolId}`,
        `- 目标 Agent：${input.targetToolId}`,
        `- 工作目录：${input.workspacePath ?? '未知'}`,
        `- 来源会话 ID：${input.sourceSessionId}`,
        `- 来源原生会话 ID：${input.sourceNativeSessionId ?? '未知'}`,
        `- 接力时间：${new Date().toISOString()}`
      ].join('\n')
    ),
    ...section('最近上下文', recent),
    ...section('终端历史', terminal),
    ...section('当前改动', input.gitSummary ?? '（没有可用的 git diff 摘要）'),
    ...section('完整历史', input.transcriptPath ? `- transcript 路径：${input.transcriptPath}` : '（无）'),
    '## 接手要求',
    '',
    '第一条回复必须包含：',
    '',
    '- 我已接手',
    '- 当前目标',
    '- 上一段已完成',
    '- 下一步计划',
    ''
  ]
  return lines.join('\n')
}
