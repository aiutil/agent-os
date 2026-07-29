// 交接文档生成（SPEC-017）。
// 规则抽取（不调用 LLM），从 NormalizedTranscript 提炼任务目标/决策/改动文件/当前卡点。

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { NormalizedMessage, NormalizedTranscript } from '@shared/types'

// 已知的文件写入工具名
const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'Create', 'NotebookEdit', 'MultiEdit'])

function extractGoal(messages: NormalizedMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim())
  return firstUser?.text.slice(0, 500).trim() ?? '（未找到任务描述）'
}

function extractChangedFiles(messages: NormalizedMessage[]): string[] {
  const files = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !msg.toolName) continue
    if (!FILE_WRITE_TOOLS.has(msg.toolName)) continue
    // 从 tool 消息 text 中提取路径（格式：JSON 或 "file_path: ..." 等）
    const pathMatches = msg.text.match(/["']?(?:file_path|path)["']?\s*[:=]\s*["']?([^\s"',}]+)/gi)
    if (pathMatches) {
      for (const m of pathMatches) {
        const extracted = m.replace(/.*[:=]\s*["']?/, '').replace(/["']$/, '').trim()
        if (extracted && extracted.length > 1) files.add(extracted)
      }
    }
    // 尝试直接从 text 中匹配路径
    const rawPaths = msg.text.match(/\/[^\s"'`,{}[\]()]+\.\w{1,10}/g)
    if (rawPaths) {
      for (const p of rawPaths.slice(0, 5)) files.add(p)
    }
  }
  return [...files].slice(0, 20)
}

function extractDecisions(messages: NormalizedMessage[]): string[] {
  const decisions: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const text = msg.text.trim()
    // 以「决定/决策/选择/采用/使用/改为」或英文 "decided/chose/going with" 等开头的短句
    const decisionPatterns =
      /(?:决定|决策|选择|采用|使用|改为|设计为|实现为|方案是|建议|注意|decided?|chose|selected|going with|opted for|switching to|using|implemented? as|the approach is|I (?:will|'ll) use|recommend|note that)[：:：]?\s*([^\n。！？.!?\n]{10,100})/gi
    let match: RegExpExecArray | null
    while ((match = decisionPatterns.exec(text)) !== null) {
      decisions.push(match[0].trim().slice(0, 120))
      if (decisions.length >= 5) break
    }
    if (decisions.length >= 5) break
  }
  return decisions
}

function extractBlocker(messages: NormalizedMessage[]): string {
  // 取最后几条 assistant 消息作为「当前进展」
  const recentAssistant = messages.filter((m) => m.role === 'assistant').slice(-3)
  return recentAssistant.map((m) => m.text.trim().slice(0, 200)).join('\n\n').trim()
}

export function generateHandoffMd(
  transcript: NormalizedTranscript,
  targetCli: string
): string {
  const { messages } = transcript
  const goal = extractGoal(messages)
  const changedFiles = extractChangedFiles(messages)
  const decisions = extractDecisions(messages)
  const blocker = extractBlocker(messages)
  const ts = new Date().toISOString()

  const lines: string[] = [
    `# 交接文档 — ${ts}`,
    '',
    `**来源 CLI**：${transcript.toolId}　→　**接收 CLI**：${targetCli}`,
    `**工作目录**：${transcript.cwd ?? '未知'}`,
    '',
    '## 任务目标',
    '',
    goal,
    '',
    '## 已改动文件',
    ''
  ]

  if (changedFiles.length > 0) {
    for (const f of changedFiles) lines.push(`- \`${f}\``)
  } else {
    lines.push('（暂无可识别的文件改动）')
  }

  if (decisions.length > 0) {
    lines.push('', '## 关键决策', '')
    for (const d of decisions) lines.push(`- ${d}`)
  }

  lines.push('', '## 当前进展 / 卡点', '', blocker || '（无额外备注）', '')

  return lines.join('\n')
}

/** 将交接文档写入工作目录 `.agent-os/handoff-<ts>.md`，返回绝对路径。 */
export function writeHandoffDoc(workspacePath: string, content: string): string {
  const dir = join(workspacePath, '.agent-os')
  mkdirSync(dir, { recursive: true })
  const filename = `handoff-${Date.now()}.md`
  const filePath = join(dir, filename)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}
