import { createHash } from 'node:crypto'
import type { ExtractKnowledgeDraftInput, KnowledgeArticle } from '@shared/types'
import { MemoryCurationService } from '../memory/curation'
import { KnowledgeVault } from './vault'

const MAX_SOURCE_LENGTH = 60_000
const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^\s'"`]{8,}/giu,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu,
  /(?:sk|rk|ghp|github_pat)_[a-z0-9_-]{16,}/giu
]

interface ExtractedArticle {
  title?: string
  summary?: string
  topic?: string
  tags?: string[]
  body?: string
}

function redact(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value)
}

function parseArticle(value: string): ExtractedArticle {
  const trimmed = value.trim().replace(/^```json\s*/iu, '').replace(/```$/u, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('知识提炼没有返回 JSON 对象')
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as ExtractedArticle
  } catch {
    throw new Error('知识提炼 JSON 无法解析')
  }
}

function sourceDigest(input: ExtractKnowledgeDraftInput): string {
  return input.source.excerptDigest ?? createHash('sha256').update(input.text).digest('hex').slice(0, 24)
}

function promptFor(input: ExtractKnowledgeDraftInput, instructions: string): string {
  return [
    'You turn one approved local conversation into a reader-facing personal knowledge article.',
    'Return JSON only: {"title":"...","summary":"...","topic":"parent/child","tags":["..."],"body":"Markdown"}.',
    'Follow the editable editorial policy below. Synthesize a coherent article instead of copying the transcript.',
    'Do not invent facts. Do not expose credentials, personal data, raw tool logs, or hidden system context.',
    'Do not include a numeric sequence in the title. This is always a draft for a human to review before publishing.',
    '',
    '# Editorial policy',
    instructions.trim(),
    '',
    'Conversation material:',
    redact(input.text).slice(0, MAX_SOURCE_LENGTH)
  ].join('\n')
}

/**
 * 知识提炼与 DurableMemory 严格分域：仅写 Markdown 草稿，默认不进入 prompt。
 * 调用模型的隔离、超时、脱敏和失败隔离沿用 MemoryCurationService。
 */
export class KnowledgeCurationService {
  constructor(
    private readonly vault: KnowledgeVault,
    private readonly restrictedRunner: MemoryCurationService
  ) {}

  async extractDraft(input: ExtractKnowledgeDraftInput): Promise<KnowledgeArticle> {
    if (!input.source.sourceId.trim() || !input.cwd.trim() || !input.text.trim()) {
      throw new Error('知识提炼需要来源、工作目录和会话内容')
    }
    const digest = sourceDigest(input)
    if (this.vault.hasSourceDigest(input.source.sourceId, digest)) {
      throw new Error('该会话摘要已经生成过知识草稿')
    }
    const output = await this.restrictedRunner.runRestricted(
      promptFor(input, this.restrictedRunner.getKnowledgeCurationPrompt()),
      input.cwd,
      {
        hasExternalContext: input.hasExternalContext
      }
    )
    const extracted = parseArticle(output)
    const title = extracted.title?.trim()
    const body = extracted.body?.trim()
    const topic = extracted.topic?.trim()
    if (!title || !body || !topic) throw new Error('知识提炼结果缺少标题、正文或主题')
    return this.vault.saveDraft({
      title,
      summary: extracted.summary?.trim(),
      body,
      topic,
      tags: extracted.tags?.filter((tag): tag is string => typeof tag === 'string'),
      sources: [{ ...input.source, excerptDigest: digest }]
    })
  }
}
