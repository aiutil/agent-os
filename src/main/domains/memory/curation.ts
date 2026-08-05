import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type { CurateMemoryInput, DurableMemory, MemoryKind, MemoryScope } from '@shared/types'
import type { CliAdapter } from '../adapters/types'
import { MemoryVault } from './vault'
import { tr } from '@shared/i18n'

const MAX_SOURCE_LENGTH = 60_000
const CURATION_TIMEOUT_MS = 120_000
const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^\s'"`]{8,}/giu,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu,
  /(?:sk|rk|ghp|github_pat)_[a-z0-9_-]{16,}/giu
]

interface CurationPayload {
  candidates?: Array<{
    kind?: string
    title?: string
    content?: string
    scope?: string
    scopeRef?: string
    tags?: string[]
  }>
}

function redact(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value)
}

function validKind(value: string | undefined): value is MemoryKind {
  return Boolean(value && ['preference', 'convention', 'decision', 'fact', 'procedure', 'pitfall', 'knowledge'].includes(value))
}

function validScope(value: string | undefined): value is MemoryScope {
  return Boolean(value && ['user', 'project', 'repo', 'path', 'agent'].includes(value))
}

function curationPrompt(source: CurateMemoryInput, instructions: string): string {
  const transcript = redact(source.text).slice(0, MAX_SOURCE_LENGTH)
  return [
    'You curate durable local memory for a coding agent.',
    'Extract at most one stable, reusable item per the curation policy below.',
    'Never output secrets, credentials, transient task progress, raw tool output, or unverified claims.',
    'Each item kind ∈ preference|convention|decision|fact|procedure|pitfall|knowledge.',
    'Return JSON only: {"candidates":[{"kind":"decision","title":"...","content":"...","scope":"repo","scopeRef":"...","tags":[]}]}.',
    'Use scope user/project/repo/path/agent. Prefer repo only when the evidence is repository-specific.',
    '',
    '# Curation policy',
    instructions.trim(),
    '',
    `Current working directory: ${source.cwd}`,
    '',
    'Eligible conversation text:',
    transcript
  ].join('\n')
}

function parsePayload(value: string): CurationPayload {
  const trimmed = value.trim().replace(/^```json\s*/iu, '').replace(/```$/u, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(tr('memory.curation.error.noJsonObject'))
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as CurationPayload
  } catch {
    throw new Error(tr('memory.curation.error.jsonParseFailed'))
  }
}

/**
 * 只使用当前已授权 CLI 的 headless 控制面，绝不把原始工具输出交给 curator。
 * 运行触发由 UI/会话空闲调度层负责；本服务只处理一次受限提炼回合。
 */
export class MemoryCurationService {
  constructor(
    private readonly vault: MemoryVault,
    private readonly getAdapter: (id: string) => CliAdapter | undefined,
    private readonly getProviderEnv: (id: string) => Record<string, string> = () => ({}),
    private readonly getProviderModel: (id: string) => string | undefined = () => undefined,
    /** 已发现/可用于提炼的适配器列表；用于在未显式配置 curator 时自动挑选。 */
    private readonly listCuratableAgents: () => CliAdapter[] = () => []
  ) {}

  /**
   * 解析本次提炼使用的 curator：优先用户显式配置；否则自动挑选——优先支持隔离提炼
   * （pi）的 CLI，其次任意带结构化 headless 通道的已安装 CLI（claude/codex…），
   * 降低默认开启门槛。
   */
  resolveCurator(explicitId?: string): CliAdapter | null {
    if (explicitId) {
      const adapter = this.getAdapter(explicitId)
      if (adapter?.headlessJson) return adapter
    }
    const candidates = this.listCuratableAgents().filter((a) => a.headlessJson)
    return (
      candidates.find((a) => a.headlessJson?.supportsIsolatedCuration) ?? candidates[0] ?? null
    )
  }

  async curate(input: CurateMemoryInput): Promise<DurableMemory[]> {
    const settings = this.vault.getSettings()
    if (!settings.enabled || !settings.generateMemories) {
      throw new Error(tr('memory.curation.error.notEnabled'))
    }
    if (input.hasExternalContext && !settings.allowExternalContext) {
      throw new Error(tr('memory.curation.error.externalContext'))
    }
    const adapter = this.resolveCurator(settings.curatorAgentId?.trim() || undefined)
    if (!adapter?.headlessJson) {
      throw new Error(tr('memory.curation.error.noCurator'))
    }
    if (!this.vault.canDepositToday()) {
      throw new Error(tr('memory.vault.error.dailyDepositLimit'))
    }
    const output = await this.run(
      adapter,
      curationPrompt(input, settings.memoryCurationPrompt),
      input.cwd,
      this.getProviderEnv(adapter.id),
      settings.curatorModel?.trim() || this.getProviderModel(adapter.id)
    )
    const payload = parsePayload(output)
    const proposals: DurableMemory[] = []
    for (const item of (payload.candidates ?? []).slice(0, 1)) {
      if (!validKind(item.kind) || !validScope(item.scope) || !item.title?.trim() || !item.content?.trim()) continue
      // 渠道会话提炼：强制 user scope（全渠道 agent 共享）并打 channelTag，记忆 UI 可按渠道筛选。
      const isChannel = Boolean(input.channelTag?.trim())
      const scope = isChannel ? 'user' : item.scope
      const scopeRef = isChannel ? undefined : item.scopeRef?.trim()
      const tags = isChannel
        ? [...new Set([...(item.tags ?? []), input.channelTag!.trim(), 'channel'].map((t) => t.trim()).filter(Boolean))]
        : item.tags
      // 自动整理仅创建候选；用户确认前不得进入 Context Pack（SPEC-028/045）。
      proposals.push(this.vault.propose({
        kind: item.kind,
        title: item.title,
        content: item.content,
        scope,
        ...(scopeRef ? { scopeRef } : {}),
        tags,
        evidence: [{ sourceType: 'session', sourceId: input.sourceId }]
      }))
    }
    // 成功提炼后统一打水位线（即便本轮没有产出候选，也记录"已看过"，避免后台反复重试）。
    this.vault.recordCuration(input.sourceId, input.messageCount ?? null)
    return proposals
  }

  /** 供知识提炼复用同一受限 headless 模型通道；不改变记忆自动提炼的水位线。 */
  async runRestricted(
    prompt: string,
    cwd: string,
    options: { hasExternalContext?: boolean } = {}
  ): Promise<string> {
    const settings = this.vault.getSettings()
    if (!settings.knowledgeCurationEnabled) throw new Error('知识提炼已在设置中关闭')
    if (options.hasExternalContext && !settings.allowExternalContext) {
      throw new Error(tr('memory.curation.error.externalContext'))
    }
    const adapter = this.resolveCurator(settings.curatorAgentId?.trim() || undefined)
    if (!adapter?.headlessJson) throw new Error(tr('memory.curation.error.noCurator'))
    return this.run(
      adapter,
      prompt,
      cwd,
      this.getProviderEnv(adapter.id),
      settings.curatorModel?.trim() || this.getProviderModel(adapter.id)
    )
  }

  /** 知识域只读取未来提炼使用的策略；已生成 Markdown 不会被追溯修改。 */
  getKnowledgeCurationPrompt(): string {
    return this.vault.getSettings().knowledgeCurationPrompt
  }

  private async run(
    adapter: CliAdapter,
    prompt: string,
    cwd: string,
    providerEnv: Record<string, string>,
    model: string | undefined
  ): Promise<string> {
    const channel = adapter.headlessJson!
    const turnId = randomUUID()
    const launch = channel.buildTurn({
      prompt,
      model,
      isolated: true,
      permissionPreset: 'safe',
      approvalUrl: 'http://127.0.0.1:9/disabled-memory-curation-hook',
      approvalToken: randomUUID(),
      turnId
    })
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: { ...process.env, ...providerEnv, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    if (launch.stdin) child.stdin.write(launch.stdin)
    child.stdin.end()

    const output: string[] = []
    const failures: string[] = []
    const parser = channel.createParser()
    const lines = createInterface({ input: child.stdout as Readable, crlfDelay: Infinity })
    const stderr = createInterface({ input: child.stderr as Readable, crlfDelay: Infinity })
    const consumeStderr = (async (): Promise<void> => {
      for await (const line of stderr) failures.push(line)
    })()
    const consume = (async (): Promise<void> => {
      for await (const line of lines) {
        for (const event of parser.parse(line)) {
          if (event.kind === 'text-delta') output.push(event.text)
          if (event.kind === 'error') failures.push(event.message)
        }
      }
    })()
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(tr('memory.curation.error.timeout')))
      }, CURATION_TIMEOUT_MS)
      child.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.on('exit', (code) => {
        clearTimeout(timeout)
        resolvePromise(code ?? 1)
      })
    })
    await Promise.all([consume, consumeStderr])
    if (exitCode !== 0 || failures.length > 0) {
      throw new Error(failures.join('\n').trim() || tr('memory.curation.error.exitCode', { code: exitCode }))
    }
    if (output.join('').trim().length === 0) throw new Error(tr('memory.curation.error.noText'))
    return output.join('')
  }
}
