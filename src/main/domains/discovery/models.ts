// SPEC-041：模型目录只来自当前 Agent 的原生协议、命令或 Agent 自己的缓存。
// 不维护任何模型 ID 静态表；发现失败时返回 unavailable，由 UI 保留 CLI 默认与自定义 ID。

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error cross-spawn 7.x 未发布 TypeScript declarations。
import crossSpawn from 'cross-spawn'
import type {
  ModelInputModality,
  ReasoningEffortOption,
  ToolModelCatalog,
  ToolModelInfo
} from '@shared/types'

const DISCOVERY_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 60_000
const MAX_DISCOVERY_OUTPUT_BYTES = 16 * 1024 * 1024

interface CacheEntry {
  catalog: ToolModelCatalog
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function unavailable(error?: string, supportsCustomModel = true): ToolModelCatalog {
  return {
    models: [],
    source: 'unavailable',
    supportsCustomModel,
    ...(error ? { error } : {})
  }
}

function runCli(
  executable: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const spawnOpts = {
      timeout: DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_DISCOVERY_OUTPUT_BYTES,
      shell: process.platform === 'win32'
    }
    try {
      execFile(executable, args, spawnOpts, (error, stdout, stderr) =>
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          ...(error ? { error: error.message } : {})
        })
      )
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

function normalizeReasoningOptions(
  values: string[],
  defaultValue?: string
): ReasoningEffortOption[] | undefined {
  const seen = new Set<string>()
  const options = values
    .map((value) => value.trim())
    .filter((value) => value && !seen.has(value) && seen.add(value))
    .map((id) => ({
      id,
      label: id,
      ...(id === defaultValue ? { isDefault: true } : {})
    }))
  return options.length ? options : undefined
}

/** 从当前 CLI 帮助文本解析 `<level>` 后的原生可选值。 */
export function parseReasoningLevels(output: string, optionName: string): ReasoningEffortOption[] {
  const escaped = optionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = output.split('\n')
  const index = lines.findIndex((candidate) =>
    new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(candidate)
  )
  if (index < 0) return []
  const line = lines.slice(index, index + 4).join(' ')
  const match =
    line.match(/\((?:choices:\s*)?([a-z][a-z0-9_-]*(?:\s*,\s*[a-z][a-z0-9_-]*)+)\)/i) ??
    line.match(/:\s*([a-z][a-z0-9_-]*(?:\s*,\s*[a-z][a-z0-9_-]*)+)/i)
  return normalizeReasoningOptions(match?.[1]?.split(',') ?? []) ?? []
}

interface CodexModelResponse {
  data?: unknown
  nextCursor?: unknown
}

/**
 * Codex 原生 app-server JSON-RPC `model/list`。该目录已按当前登录账户和 CLI
 * 版本过滤，同时给出模型级 reasoning effort 与输入模态。
 */
async function discoverCodex(executable: string): Promise<ToolModelCatalog> {
  return new Promise((resolve) => {
    const child = crossSpawn(executable, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdoutBuffer = ''
    let stderr = ''
    let settled = false
    let nextRequestId = 2
    const models: ToolModelInfo[] = []

    const finish = (catalog: ToolModelCatalog): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(catalog)
    }

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    const requestPage = (cursor?: string): void => {
      const id = nextRequestId++
      send({
        method: 'model/list',
        id,
        params: {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {})
        }
      })
    }

    const handleLine = (line: string): void => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (message.id === 1 && message.result) {
        send({ method: 'initialized', params: {} })
        requestPage()
        return
      }
      if (typeof message.id !== 'number' || message.id < 2) return
      if (message.error) {
        finish(unavailable('Codex model/list returned an error'))
        return
      }
      const result = (message.result ?? {}) as CodexModelResponse
      if (!Array.isArray(result.data)) {
        finish(unavailable('Codex model/list returned an invalid response'))
        return
      }
      models.push(...parseCodexModels(result.data))
      const nextCursor = stringValue(result.nextCursor)
      if (nextCursor) {
        requestPage(nextCursor)
        return
      }
      finish({
        models: dedupeModels(models),
        source: 'native',
        supportsCustomModel: true
      })
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += String(chunk)
      let newline = stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) handleLine(line)
        newline = stdoutBuffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 2000) stderr += String(chunk)
    })
    child.on('error', (error: Error) => finish(unavailable(error.message)))
    child.on('exit', () => {
      if (!settled) finish(unavailable(stderr.trim() || 'Codex app-server exited early'))
    })

    const timer = setTimeout(
      () => finish(unavailable('Codex model/list timed out')),
      DISCOVERY_TIMEOUT_MS
    )
    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'agent-os', title: 'Agent OS', version: '1' },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }
    })
  })
}

export function parseCodexModels(data: unknown[]): ToolModelInfo[] {
  const models: ToolModelInfo[] = []
  for (const raw of data) {
    if (!isRecord(raw)) continue
    const id = stringValue(raw.model) ?? stringValue(raw.id)
    if (!id || raw.hidden === true) continue
    const defaultReasoning = stringValue(raw.defaultReasoningEffort)
    const reasoningValues = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
          .map((option) =>
            isRecord(option) ? stringValue(option.reasoningEffort) : undefined
          )
          .filter((value): value is string => Boolean(value))
      : []
    const reasoningEfforts = normalizeReasoningOptions(reasoningValues, defaultReasoning)
    const inputModalities = normalizeModalities(raw.inputModalities)
    models.push({
      id,
      label: stringValue(raw.displayName) ?? id,
      provider: 'openai',
      ...(raw.isDefault === true ? { isDefault: true } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(inputModalities.length ? { inputModalities } : {})
    })
  }
  return dedupeModels(models)
}

/** OpenCode `models --verbose`：ID 行后紧跟一段完整 JSON 元数据。 */
export function parseOpenCodeModels(output: string): ToolModelInfo[] {
  const lines = output.split('\n')
  const models: ToolModelInfo[] = []
  let pendingId: string | undefined
  let json = ''

  const commit = (metadata: unknown): void => {
    if (!pendingId) return
    const meta = isRecord(metadata) ? metadata : {}
    const capabilities = isRecord(meta.capabilities) ? meta.capabilities : {}
    const input = isRecord(capabilities.input) ? capabilities.input : {}
    const variants = isRecord(meta.variants) ? Object.keys(meta.variants) : []
    const modalities: ModelInputModality[] = ['text']
    if (input.image === true) modalities.push('image')
    if (input.pdf === true) modalities.push('pdf')
    if (capabilities.attachment === true) modalities.push('file')
    const provider = pendingId.includes('/') ? pendingId.slice(0, pendingId.indexOf('/')) : undefined
    models.push({
      id: pendingId,
      label: stringValue(meta.name) ?? pendingId,
      ...(provider ? { provider } : {}),
      ...(normalizeReasoningOptions(variants)
        ? { reasoningEfforts: normalizeReasoningOptions(variants) }
        : {}),
      inputModalities: modalities
    })
    pendingId = undefined
    json = ''
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!pendingId) {
      if (/^[^\s/]+\/[^\s]+$/.test(line)) pendingId = line
      continue
    }
    if (!json && !line.startsWith('{')) continue
    json += `${raw}\n`
    try {
      commit(JSON.parse(json))
    } catch {
      // Pretty JSON 尚未完整，继续累计。
    }
  }
  if (pendingId) commit({})
  return dedupeModels(models)
}

export function parsePiModels(
  output: string,
  reasoningEfforts: ReasoningEffortOption[] = []
): ToolModelInfo[] {
  const models: ToolModelInfo[] = []
  for (const raw of output.split('\n')) {
    const fields = raw
      .trim()
      .split(/\s{2,}|\t/)
      .map((field) => field.trim())
      .filter(Boolean)
    if (fields.length < 2) continue
    const [provider, model, _context, _maxOut, thinking, images] = fields
    if (provider.toLowerCase() === 'provider' && model.toLowerCase() === 'model') continue
    const inputModalities: ModelInputModality[] = ['text', 'file']
    if (images?.toLowerCase() === 'yes') inputModalities.push('image')
    models.push({
      id: `${provider}/${model}`,
      label: model,
      provider,
      ...(thinking?.toLowerCase() === 'yes' && reasoningEfforts.length
        ? { reasoningEfforts }
        : {}),
      inputModalities
    })
  }
  return dedupeModels(models)
}

export function parseCursorModels(output: string): ToolModelInfo[] {
  const models: ToolModelInfo[] = []
  for (const raw of output.split('\n')) {
    const match = raw.trim().match(/^(\S+)\s+-\s+(.+)$/)
    if (!match) continue
    const [, id, description] = match
    models.push({
      id,
      label: description,
      provider: 'cursor',
      ...(description.toLowerCase().includes('default') ? { isDefault: true } : {})
    })
  }
  return dedupeModels(models)
}

export function parseHermesModelsCache(output: string): ToolModelInfo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []
  const models: ToolModelInfo[] = []
  for (const [provider, entry] of Object.entries(parsed)) {
    if (!isRecord(entry) || !Array.isArray(entry.models)) continue
    for (const value of entry.models) {
      const model = typeof value === 'string' ? value : undefined
      if (!model) continue
      models.push({
        id: `${provider}/${model}`,
        label: model,
        provider
      })
    }
  }
  return dedupeModels(models)
}

async function discoverOpenCode(executable: string): Promise<ToolModelCatalog> {
  const result = await runCli(executable, ['models', '--verbose'])
  const models = parseOpenCodeModels(result.stdout)
  return models.length
    ? { models, source: 'native', supportsCustomModel: true }
    : unavailable(result.error ?? (result.stderr.trim() || undefined))
}

async function discoverPi(executable: string): Promise<ToolModelCatalog> {
  const [list, help] = await Promise.all([
    runCli(executable, ['--list-models']),
    runCli(executable, ['--help'])
  ])
  const reasoningEfforts = parseReasoningLevels(help.stdout, '--thinking')
  const models = parsePiModels(list.stdout, reasoningEfforts)
  return models.length
    ? { models, source: 'native', supportsCustomModel: true, reasoningEfforts }
    : {
        ...unavailable(list.error ?? (list.stderr.trim() || undefined)),
        ...(reasoningEfforts.length ? { reasoningEfforts } : {})
      }
}

async function discoverCursor(executable: string): Promise<ToolModelCatalog> {
  const result = await runCli(executable, ['--list-models'])
  const models = parseCursorModels(result.stdout)
  return models.length
    ? { models, source: 'native', supportsCustomModel: true }
    : unavailable(result.error ?? (result.stderr.trim() || undefined))
}

async function discoverClaude(executable: string): Promise<ToolModelCatalog> {
  const help = await runCli(executable, ['--help'])
  const reasoningEfforts = parseReasoningLevels(help.stdout, '--effort')
  return {
    ...unavailable(
      help.error ? `Claude model catalog unavailable: ${help.error}` : undefined,
      true
    ),
    ...(reasoningEfforts.length ? { reasoningEfforts } : {})
  }
}

async function discoverHermes(): Promise<ToolModelCatalog> {
  const hermesHome = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
  try {
    const models = parseHermesModelsCache(
      await readFile(join(hermesHome, 'provider_models_cache.json'), 'utf8')
    )
    return models.length
      ? { models, source: 'native-cache', supportsCustomModel: true }
      : unavailable('Hermes native model cache is empty')
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error))
  }
}

export async function listToolModels(
  toolId: string,
  executablePath?: string
): Promise<ToolModelCatalog> {
  const executable = executablePath || defaultExecutable(toolId)
  const key = `${toolId}::${executable}`
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.catalog

  let catalog: ToolModelCatalog
  switch (toolId) {
    case 'codex':
      catalog = await discoverCodex(executable)
      break
    case 'opencode':
      catalog = await discoverOpenCode(executable)
      break
    case 'pi':
      catalog = await discoverPi(executable)
      break
    case 'cursor-agent':
      catalog = await discoverCursor(executable)
      break
    case 'claude':
      catalog = await discoverClaude(executable)
      break
    case 'hermes':
      catalog = await discoverHermes()
      break
    case 'gemini':
    case 'openclaw':
      catalog = unavailable(undefined, true)
      break
    default:
      catalog = unavailable(undefined, false)
  }
  cache.set(key, { catalog, expiresAt: Date.now() + CACHE_TTL_MS })
  return catalog
}

function defaultExecutable(toolId: string): string {
  return toolId === 'cursor-agent' ? 'cursor-agent' : toolId
}

function dedupeModels(models: ToolModelInfo[]): ToolModelInfo[] {
  const seen = new Set<string>()
  return models.filter((model) => Boolean(model.id) && !seen.has(model.id) && seen.add(model.id))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeModalities(value: unknown): ModelInputModality[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is ModelInputModality =>
      item === 'text' || item === 'image' || item === 'file' || item === 'pdf'
  )
}
