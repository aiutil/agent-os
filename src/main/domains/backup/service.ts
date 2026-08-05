import { createHash } from 'node:crypto'
import {
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type {
  AgentTask,
  DurableMemory,
  KnowledgeArticle,
  KnowledgeComment,
  MemorySettings,
  PortableBackupImportResult,
  PortableBackupSummary,
  PortableBackupV1,
  PortableKnowledgeArticle,
  PortableKnowledgeState,
  PortableProviderPreference,
  RuntimeHost,
  TaskSchedule,
  UpdateTaskPatch
} from '@shared/types'
import {
  DEFAULT_KNOWLEDGE_CURATION_PROMPT,
  DEFAULT_MEMORY_CURATION_PROMPT
} from '@shared/curation-prompts'
import { listAdapters } from '../adapters/registry'
import { normalizeSchedule } from '../tasks/cron'
import type { MemoryVault } from '../memory/vault'
import type { KnowledgeVault } from '../knowledge/vault'
import {
  getGamificationEnabled,
  getLanguage,
  getMirrorSettings,
  getProviderConfig,
  setGamificationEnabled,
  setLanguage,
  setMirrorSettings,
  setProviderConfig
} from '../../store/app-store'

const MAX_BACKUP_BYTES = 20 * 1024 * 1024
const MEMORY_STATUSES = new Set(['candidate', 'active', 'superseded', 'archived'])
const MEMORY_KINDS = new Set([
  'preference',
  'convention',
  'decision',
  'fact',
  'procedure',
  'pitfall',
  'knowledge'
])
const MEMORY_SCOPES = new Set(['user', 'project', 'repo', 'path', 'agent'])
const TASK_BOARD_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'])
const PERMISSION_PRESETS = new Set(['safe', 'acceptEdits', 'auto'])
const SESSION_POLICIES = new Set(['new', 'continue_last'])

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`备份字段无效：${label}`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return string(value, label, true)
}

function portableUrl(value: unknown, label: string): string | undefined {
  const raw = optionalString(value, label)?.trim()
  if (!raw) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`备份字段无效：${label}`)
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`备份 URL 不允许凭据、查询参数或片段：${label}`)
  }
  return parsed.toString().replace(/\/$/, raw.endsWith('/') ? '/' : '')
}

function exportPortableUrl(value: string | undefined): string | undefined {
  try {
    return portableUrl(value, 'export.url')
  } catch {
    return undefined
  }
}

function validDate(value: unknown, label: string): string {
  const text = string(value, label)
  if (!Number.isFinite(new Date(text).getTime())) throw new Error(`备份日期无效：${label}`)
  return text
}

function parseSchedule(value: unknown): TaskSchedule {
  if (!value || typeof value !== 'object') throw new Error('备份任务 schedule 无效')
  const row = value as Record<string, unknown>
  const kind = string(row.kind, 'task.schedule.kind')
  const timeZone = string(row.timeZone, 'task.schedule.timeZone')
  const enabled = row.enabled
  const misfirePolicy = string(row.misfirePolicy, 'task.schedule.misfirePolicy')
  if (typeof enabled !== 'boolean' || !['run_once', 'skip'].includes(misfirePolicy)) {
    throw new Error('备份任务 schedule 基础字段无效')
  }
  const base = {
    timeZone,
    enabled: false,
    misfirePolicy: misfirePolicy as TaskSchedule['misfirePolicy']
  }
  if (kind === 'once') {
    return normalizeSchedule(
      { ...base, kind: 'once', runAt: validDate(row.runAt, 'task.schedule.runAt') },
      new Date()
    )
  }
  if (kind === 'cron') {
    return normalizeSchedule(
      { ...base, kind: 'cron', expression: string(row.expression, 'task.schedule.expression') },
      new Date()
    )
  }
  if (kind === 'interval') {
    if (typeof row.everyMs !== 'number') throw new Error('备份任务 interval.everyMs 无效')
    return normalizeSchedule(
      {
        ...base,
        kind: 'interval',
        everyMs: row.everyMs,
        anchorAt: validDate(row.anchorAt, 'task.schedule.anchorAt')
      },
      new Date()
    )
  }
  throw new Error('备份任务 schedule 类型无效')
}

function parseProvider(value: unknown): PortableProviderPreference {
  if (!value || typeof value !== 'object') throw new Error('备份 provider 配置无效')
  const row = value as Record<string, unknown>
  const baseUrl = portableUrl(row.baseUrl, 'provider.baseUrl')
  const model = optionalString(row.model, 'provider.model')?.trim()
  return {
    toolId: string(row.toolId, 'provider.toolId'),
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {})
  }
}

function parseMemory(value: unknown): DurableMemory {
  if (!value || typeof value !== 'object') throw new Error('备份记忆条目无效')
  const row = value as Record<string, unknown>
  const kind = string(row.kind, 'memory.kind')
  const scope = string(row.scope, 'memory.scope')
  const status = string(row.status, 'memory.status')
  if (!MEMORY_KINDS.has(kind) || !MEMORY_SCOPES.has(scope) || !MEMORY_STATUSES.has(status)) {
    throw new Error('备份记忆枚举值无效')
  }
  if (!Array.isArray(row.tags) || !row.tags.every((item) => typeof item === 'string')) {
    throw new Error('备份记忆 tags 无效')
  }
  if (!Array.isArray(row.evidence)) throw new Error('备份记忆 evidence 无效')
  const evidence = row.evidence.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('备份记忆 evidence 无效')
    const evidenceRow = item as Record<string, unknown>
    const sourceType = string(evidenceRow.sourceType, 'memory.evidence.sourceType')
    if (!['session', 'file', 'manual', 'agent'].includes(sourceType)) {
      throw new Error('备份记忆 evidence sourceType 无效')
    }
    return {
      sourceType: sourceType as DurableMemory['evidence'][number]['sourceType'],
      sourceId: string(evidenceRow.sourceId, 'memory.evidence.sourceId')
    }
  })
  const confidence = string(row.confidence, 'memory.confidence')
  const sensitivity = string(row.sensitivity, 'memory.sensitivity')
  if (
    !['confirmed', 'inferred'].includes(confidence) ||
    !['normal', 'private'].includes(sensitivity) ||
    typeof row.pinned !== 'boolean'
  ) {
    throw new Error('备份记忆可信度、敏感级别或 pinned 无效')
  }
  const expiresAt = optionalString(row.expiresAt, 'memory.expiresAt')
  const rejectionReason = optionalString(row.rejectionReason, 'memory.rejectionReason')
  const memoryClass = optionalString(row.memoryClass, 'memory.memoryClass')
  if (memoryClass && !['identity', 'semantic', 'episodic', 'procedural'].includes(memoryClass)) {
    throw new Error('备份记忆类别无效')
  }
  const lastAccessedAt = optionalString(row.lastAccessedAt, 'memory.lastAccessedAt')
  const validFrom = optionalString(row.validFrom, 'memory.validFrom')
  const validUntil = optionalString(row.validUntil, 'memory.validUntil')
  if (row.legacy !== undefined && typeof row.legacy !== 'boolean') throw new Error('备份记忆 legacy 无效')
  if (row.accessCount !== undefined && (typeof row.accessCount !== 'number' || row.accessCount < 0)) {
    throw new Error('备份记忆访问次数无效')
  }
  return {
    id: string(row.id, 'memory.id'),
    kind: kind as DurableMemory['kind'],
    title: string(row.title, 'memory.title'),
    content: string(row.content, 'memory.content'),
    scope: scope as DurableMemory['scope'],
    ...(optionalString(row.scopeRef, 'memory.scopeRef') ? { scopeRef: String(row.scopeRef) } : {}),
    status: status as DurableMemory['status'],
    confidence: confidence as DurableMemory['confidence'],
    sensitivity: sensitivity as DurableMemory['sensitivity'],
    tags: [...row.tags] as string[],
    evidence,
    pinned: row.pinned,
    createdAt: validDate(row.createdAt, 'memory.createdAt'),
    updatedAt: validDate(row.updatedAt, 'memory.updatedAt'),
    ...(memoryClass ? { memoryClass: memoryClass as DurableMemory['memoryClass'] } : {}),
    ...(typeof row.legacy === 'boolean' ? { legacy: row.legacy } : {}),
    ...(typeof row.accessCount === 'number' ? { accessCount: row.accessCount } : {}),
    ...(lastAccessedAt ? { lastAccessedAt: validDate(lastAccessedAt, 'memory.lastAccessedAt') } : {}),
    ...(validFrom ? { validFrom: validDate(validFrom, 'memory.validFrom') } : {}),
    ...(validUntil ? { validUntil: validDate(validUntil, 'memory.validUntil') } : {}),
    ...(expiresAt ? { expiresAt: validDate(expiresAt, 'memory.expiresAt') } : {}),
    ...(rejectionReason ? { rejectionReason } : {})
  }
}

function parseKnowledgeArticle(value: unknown): PortableKnowledgeArticle {
  if (!value || typeof value !== 'object') throw new Error('备份知识文章无效')
  const row = value as Record<string, unknown>
  const status = string(row.status, 'knowledge.status')
  if (!['draft', 'published', 'archived'].includes(status)) throw new Error('备份知识文章状态无效')
  if (!Array.isArray(row.tags) || !row.tags.every((item) => typeof item === 'string')) throw new Error('备份知识文章 tags 无效')
  if (!Array.isArray(row.sources)) throw new Error('备份知识文章 sources 无效')
  const sources = row.sources.map((source) => {
    if (!source || typeof source !== 'object') throw new Error('备份知识文章来源无效')
    const item = source as Record<string, unknown>
    const sourceType = string(item.sourceType, 'knowledge.source.sourceType')
    if (!['session', 'manual'].includes(sourceType)) throw new Error('备份知识文章来源类型无效')
    return {
      sourceType: sourceType as KnowledgeArticle['sources'][number]['sourceType'],
      sourceId: string(item.sourceId, 'knowledge.source.sourceId'),
      ...(optionalString(item.toolId, 'knowledge.source.toolId') ? { toolId: String(item.toolId) } : {}),
      ...(typeof item.messageStart === 'number' ? { messageStart: item.messageStart } : {}),
      ...(typeof item.messageEnd === 'number' ? { messageEnd: item.messageEnd } : {}),
      ...(optionalString(item.excerptDigest, 'knowledge.source.excerptDigest') ? { excerptDigest: String(item.excerptDigest) } : {})
    }
  })
  const favorite = row.favorite
  if (typeof favorite !== 'boolean') throw new Error('备份知识文章收藏状态无效')
  const publishedAt = optionalString(row.publishedAt, 'knowledge.publishedAt')
  const favoriteAt = optionalString(row.favoriteAt, 'knowledge.favoriteAt')
  if (typeof row.wordCount !== 'number' || row.wordCount < 0) throw new Error('备份知识文章字数无效')
  return {
    id: string(row.id, 'knowledge.id'),
    title: string(row.title, 'knowledge.title'),
    summary: string(row.summary, 'knowledge.summary', true),
    body: string(row.body, 'knowledge.body'),
    status: status as KnowledgeArticle['status'],
    topic: string(row.topic, 'knowledge.topic'),
    tags: [...row.tags] as string[],
    sources,
    createdAt: validDate(row.createdAt, 'knowledge.createdAt'),
    updatedAt: validDate(row.updatedAt, 'knowledge.updatedAt'),
    ...(publishedAt ? { publishedAt: validDate(publishedAt, 'knowledge.publishedAt') } : {}),
    favorite,
    ...(favoriteAt ? { favoriteAt: validDate(favoriteAt, 'knowledge.favoriteAt') } : {}),
    wordCount: row.wordCount
  }
}

function parseKnowledgeComment(value: unknown): KnowledgeComment {
  if (!value || typeof value !== 'object') throw new Error('备份知识评论无效')
  const row = value as Record<string, unknown>
  const anchor = row.anchor
  if (anchor !== undefined && (!anchor || typeof anchor !== 'object')) throw new Error('备份知识评论锚点无效')
  return {
    id: string(row.id, 'knowledge.comment.id'),
    articleId: string(row.articleId, 'knowledge.comment.articleId'),
    body: string(row.body, 'knowledge.comment.body'),
    ...(anchor ? { anchor: anchor as KnowledgeComment['anchor'] } : {}),
    createdAt: validDate(row.createdAt, 'knowledge.comment.createdAt'),
    updatedAt: validDate(row.updatedAt, 'knowledge.comment.updatedAt')
  }
}

function parseKnowledge(value: unknown): PortableKnowledgeState | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('备份知识结构无效')
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.articles) || !Array.isArray(row.comments)) throw new Error('备份知识结构无效')
  const articles = requireUnique(row.articles.map(parseKnowledgeArticle), (article) => article.id, 'knowledge.article.id')
  const comments = requireUnique(row.comments.map(parseKnowledgeComment), (comment) => comment.id, 'knowledge.comment.id')
  return { articles, comments }
}

function parseTask(value: unknown): AgentTask {
  if (!value || typeof value !== 'object') throw new Error('备份任务条目无效')
  const row = value as Record<string, unknown>
  const assignee = row.assignee as Record<string, unknown> | undefined
  if (!assignee || typeof assignee !== 'object') throw new Error('备份任务 assignee 无效')
  const boardStatus = string(row.boardStatus, 'task.boardStatus')
  const permissionPreset = string(row.permissionPreset, 'task.permissionPreset')
  const sessionPolicy = string(row.sessionPolicy, 'task.sessionPolicy')
  const id = string(row.id, 'task.id')
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(id) ||
    !TASK_BOARD_STATUSES.has(boardStatus) ||
    !PERMISSION_PRESETS.has(permissionPreset) ||
    !SESSION_POLICIES.has(sessionPolicy)
  ) {
    throw new Error('备份任务枚举值无效')
  }
  const model = optionalString(assignee.model, 'task.assignee.model')?.trim()
  const schedule = row.schedule === undefined ? undefined : parseSchedule(row.schedule)
  return {
    id,
    title: string(row.title, 'task.title'),
    prompt: string(row.prompt, 'task.prompt'),
    workspacePath: string(row.workspacePath, 'task.workspacePath'),
    assignee: {
      toolId: string(assignee.toolId, 'task.assignee.toolId'),
      ...(model ? { model } : {})
    },
    boardStatus: boardStatus as AgentTask['boardStatus'],
    executionStatus: 'idle',
    permissionPreset: permissionPreset as AgentTask['permissionPreset'],
    sessionPolicy: sessionPolicy as AgentTask['sessionPolicy'],
    ...(schedule ? { schedule } : {}),
    createdAt: validDate(row.createdAt, 'task.createdAt'),
    updatedAt: validDate(row.updatedAt, 'task.updatedAt')
  }
}

function parseMemorySettings(value: unknown): MemorySettings {
  if (!value || typeof value !== 'object') throw new Error('备份记忆设置无效')
  const row = value as Partial<MemorySettings>
  if (
    typeof row.enabled !== 'boolean' ||
    typeof row.useMemories !== 'boolean' ||
    typeof row.generateMemories !== 'boolean' ||
    (row.knowledgeCurationEnabled !== undefined && typeof row.knowledgeCurationEnabled !== 'boolean') ||
    typeof row.allowExternalContext !== 'boolean' ||
    typeof row.contextTokenBudget !== 'number' ||
    !Number.isFinite(row.contextTokenBudget) ||
    row.contextTokenBudget < 200 ||
    row.contextTokenBudget > 2_000
  ) {
    throw new Error('备份记忆设置字段无效')
  }
  const curatorAgentId = optionalString(row.curatorAgentId, 'memory.settings.curatorAgentId')?.trim()
  const curatorModel = optionalString(row.curatorModel, 'memory.settings.curatorModel')?.trim()
  const curationInstructions = optionalString(
    row.curationInstructions,
    'memory.settings.curationInstructions'
  )
  const memoryCurationPrompt = optionalString(
    row.memoryCurationPrompt,
    'memory.settings.memoryCurationPrompt'
  )
  const knowledgeCurationPrompt = optionalString(
    row.knowledgeCurationPrompt,
    'memory.settings.knowledgeCurationPrompt'
  )
  const curationEpoch = optionalString(row.curationEpoch, 'memory.settings.curationEpoch')
  return {
    enabled: row.enabled,
    useMemories: row.useMemories,
    generateMemories: row.generateMemories,
    knowledgeCurationEnabled: row.knowledgeCurationEnabled ?? true,
    allowExternalContext: row.allowExternalContext,
    contextTokenBudget: row.contextTokenBudget,
    memoryCurationPrompt:
      memoryCurationPrompt?.trim() ||
      curationInstructions?.trim() ||
      DEFAULT_MEMORY_CURATION_PROMPT,
    knowledgeCurationPrompt:
      knowledgeCurationPrompt?.trim() || DEFAULT_KNOWLEDGE_CURATION_PROMPT,
    ...(curatorAgentId ? { curatorAgentId } : {}),
    ...(curatorModel ? { curatorModel } : {}),
    ...(curationEpoch ? { curationEpoch: validDate(curationEpoch, 'memory.settings.curationEpoch') } : {})
  }
}

function summary(backup: PortableBackupV1): PortableBackupSummary {
  return {
    sourceVersion: backup.sourceVersion,
    exportedAt: backup.exportedAt,
    memories: backup.memory.items.length,
    tasks: backup.tasks.length,
    providers: backup.preferences.providers.length,
    knowledgeArticles: backup.knowledge?.articles.length ?? 0,
    schedulesWillBePaused: backup.tasks.filter((task) => task.schedule).length,
    credentialsExcluded: true
  }
}

function taskPatch(task: AgentTask): UpdateTaskPatch {
  return {
    title: task.title,
    prompt: task.prompt,
    workspacePath: task.workspacePath,
    assignee: task.assignee,
    boardStatus:
      task.boardStatus === 'backlog' || task.boardStatus === 'todo' ? task.boardStatus : 'todo',
    permissionPreset: task.permissionPreset,
    sessionPolicy: task.sessionPolicy,
    schedule: task.schedule ?? null
  }
}

function portableTask(task: AgentTask): AgentTask {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    workspacePath: task.workspacePath,
    assignee: {
      toolId: task.assignee.toolId,
      ...(task.assignee.model ? { model: task.assignee.model } : {})
    },
    boardStatus:
      task.boardStatus === 'backlog' || task.boardStatus === 'todo' ? task.boardStatus : 'todo',
    executionStatus: 'idle',
    permissionPreset: task.permissionPreset,
    sessionPolicy: task.sessionPolicy,
    ...(task.schedule ? { schedule: { ...task.schedule } } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }
}

function contentFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function requireUnique<T>(items: T[], key: (item: T) => string, label: string): T[] {
  const seen = new Set<string>()
  for (const item of items) {
    const value = key(item)
    if (seen.has(value)) throw new Error(`备份包含重复 ${label}：${value}`)
    seen.add(value)
  }
  return items
}

export class PortableBackupService {
  constructor(
    private readonly runtime: RuntimeHost,
    private readonly vault: MemoryVault,
    private readonly appVersion: string,
    private readonly knowledge?: KnowledgeVault
  ) {}

  async build(): Promise<PortableBackupV1> {
    const memory = this.vault.portableState()
    const providers = listAdapters()
      .map((adapter) => getProviderConfig(adapter.id))
      .filter((config) => config.baseUrl || config.model)
      .map(({ toolId, baseUrl, model }) => {
        const safeBaseUrl = exportPortableUrl(baseUrl)
        return {
          toolId,
          ...(safeBaseUrl ? { baseUrl: safeBaseUrl } : {}),
          ...(model ? { model } : {})
        }
      })
      .filter((config) => config.baseUrl || config.model)
    const mirror = getMirrorSettings()
    const npmRegistry = exportPortableUrl(mirror.npmRegistry)
    const httpsProxy = exportPortableUrl(mirror.httpsProxy)
    return {
      schemaVersion: 1,
      product: 'Agent OS',
      exportedAt: new Date().toISOString(),
      sourceVersion: this.appVersion,
      preferences: {
        language: getLanguage(),
        gamificationEnabled: getGamificationEnabled(),
        mirrorSettings: {
          ...(npmRegistry ? { npmRegistry } : {}),
          ...(httpsProxy ? { httpsProxy } : {})
        },
        providers
      },
      memory,
      ...(this.knowledge ? { knowledge: this.knowledge.portableState() } : {}),
      tasks: (await this.runtime.listTasks())
        .filter((task) => !task.runtimeHostId || task.runtimeHostId === 'local')
        .map(portableTask)
    }
  }

  async exportTo(filePath: string): Promise<PortableBackupSummary> {
    const backup = await this.build()
    const content = `${JSON.stringify(backup, null, 2)}\n`
    if (Buffer.byteLength(content, 'utf8') > MAX_BACKUP_BYTES) {
      throw new Error('备份内容超过 20 MiB，请先精简记忆或知识文章')
    }
    const temporary = `${filePath}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, filePath)
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        // rename 成功后临时文件已不存在；失败时尽力清理不完整文件。
      }
    }
    try {
      chmodSync(filePath, 0o600)
    } catch {
      // Windows filesystems may not expose POSIX modes.
    }
    return summary(backup)
  }

  private readContent(filePath: string): string {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_BACKUP_BYTES) {
      throw new Error('备份文件无效或超过 20 MiB')
    }
    const content = readFileSync(filePath, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_BACKUP_BYTES) {
      throw new Error('备份文件无效或超过 20 MiB')
    }
    return content
  }

  fingerprint(filePath: string): string {
    return contentFingerprint(this.readContent(filePath))
  }

  read(filePath: string): PortableBackupV1 {
    return this.parse(this.readContent(filePath))
  }

  private parse(content: string): PortableBackupV1 {
    const raw = JSON.parse(content) as Record<string, unknown>
    if (raw.schemaVersion !== 1 || raw.product !== 'Agent OS') {
      throw new Error('不支持的 Agent OS 备份版本')
    }
    const preferences = raw.preferences as Record<string, unknown>
    const memory = raw.memory as Record<string, unknown>
    if (!preferences || !memory || !Array.isArray(raw.tasks)) {
      throw new Error('备份缺少必要字段')
    }
    const language = string(preferences.language, 'preferences.language')
    if (!['zh', 'en'].includes(language)) throw new Error('备份语言无效')
    if (
      typeof preferences.gamificationEnabled !== 'boolean' ||
      !preferences.mirrorSettings ||
      typeof preferences.mirrorSettings !== 'object' ||
      !Array.isArray(preferences.providers) ||
      !Array.isArray(memory.items)
    ) {
      throw new Error('备份偏好或记忆结构无效')
    }
    const mirror = preferences.mirrorSettings as Record<string, unknown>
    const npmRegistry = portableUrl(mirror.npmRegistry, 'mirror.npmRegistry')
    const httpsProxy = portableUrl(mirror.httpsProxy, 'mirror.httpsProxy')
    const providers = requireUnique(
      preferences.providers.map(parseProvider),
      (provider) => provider.toolId,
      'provider'
    )
    const knownProviderIds = new Set(listAdapters().map((adapter) => adapter.id))
    for (const provider of providers) {
      if (!knownProviderIds.has(provider.toolId)) {
        throw new Error(`备份包含未知 provider：${provider.toolId}`)
      }
    }
    const memories = requireUnique(memory.items.map(parseMemory), (item) => item.id, 'memory.id')
    const knowledge = parseKnowledge(raw.knowledge)
    const tasks = requireUnique(raw.tasks.map(parseTask), (task) => task.id, 'task.id')
    return {
      schemaVersion: 1,
      product: 'Agent OS',
      exportedAt: validDate(raw.exportedAt, 'exportedAt'),
      sourceVersion: string(raw.sourceVersion, 'sourceVersion'),
      preferences: {
        language: language as PortableBackupV1['preferences']['language'],
        gamificationEnabled: preferences.gamificationEnabled,
        mirrorSettings: {
          ...(npmRegistry ? { npmRegistry } : {}),
          ...(httpsProxy ? { httpsProxy } : {})
        },
        providers
      },
      memory: {
        persona: string(memory.persona, 'memory.persona', true),
        settings: parseMemorySettings(memory.settings),
        items: memories
      },
      ...(knowledge ? { knowledge } : {}),
      tasks
    }
  }

  preview(filePath: string): PortableBackupSummary {
    return summary(this.read(filePath))
  }

  async importFrom(
    filePath: string,
    expectedFingerprint?: string
  ): Promise<PortableBackupImportResult> {
    const content = this.readContent(filePath)
    if (expectedFingerprint && contentFingerprint(content) !== expectedFingerprint) {
      throw new Error('备份文件在预览后发生变化，请重新选择')
    }
    const backup = this.parse(content)
    const previousMemory = this.vault.portableState()
    const previousKnowledge = this.knowledge?.portableState()
    const previousPreferences = {
      language: getLanguage(),
      gamificationEnabled: getGamificationEnabled(),
      mirrorSettings: getMirrorSettings(),
      providers: new Map(
        backup.preferences.providers.map((provider) => [
          provider.toolId,
          getProviderConfig(provider.toolId)
        ])
      )
    }
    const existingTasks = (await this.runtime.listTasks()).filter(
      (task) => !task.runtimeHostId || task.runtimeHostId === 'local'
    )
    const existingById = new Map(existingTasks.map((task) => [task.id, task]))
    const createdTaskIds: string[] = []
    const touchedExisting: AgentTask[] = []
    try {
      setLanguage(backup.preferences.language)
      setGamificationEnabled(backup.preferences.gamificationEnabled)
      setMirrorSettings(backup.preferences.mirrorSettings)
      for (const provider of backup.preferences.providers) {
        const current = getProviderConfig(provider.toolId)
        setProviderConfig({
          ...current,
          toolId: provider.toolId,
          baseUrl: provider.baseUrl,
          model: provider.model
        })
      }

      const mergedMemories = new Map(previousMemory.items.map((item) => [item.id, item]))
      for (const item of backup.memory.items) mergedMemories.set(item.id, item)
      this.vault.replacePortableState({
        persona: backup.memory.persona,
        settings: backup.memory.settings,
        items: [...mergedMemories.values()]
      })
      if (backup.knowledge && this.knowledge) this.knowledge.replacePortableState(backup.knowledge)

      for (const imported of backup.tasks) {
        const existing = existingById.get(imported.id)
        if (existing) {
          touchedExisting.push(existing)
          await this.runtime.updateTask(existing.id, taskPatch(imported))
        } else {
          const created = await this.runtime.createTask({
            portableId: imported.id,
            title: imported.title,
            prompt: imported.prompt,
            workspacePath: imported.workspacePath,
            assignee: imported.assignee,
            boardStatus: imported.boardStatus === 'backlog' ? 'backlog' : 'todo',
            permissionPreset: imported.permissionPreset,
            sessionPolicy: imported.sessionPolicy,
            schedule: imported.schedule,
            creationSource: 'manual'
          })
          createdTaskIds.push(created.id)
        }
      }
      return {
        importedMemories: backup.memory.items.length,
        importedTasks: backup.tasks.length,
        importedProviders: backup.preferences.providers.length,
        ...(backup.knowledge ? { importedKnowledgeArticles: backup.knowledge.articles.length } : {}),
        schedulesPaused: backup.tasks.filter((task) => task.schedule).length
      }
    } catch (error) {
      setLanguage(previousPreferences.language)
      setGamificationEnabled(previousPreferences.gamificationEnabled)
      setMirrorSettings(previousPreferences.mirrorSettings)
      for (const previous of previousPreferences.providers.values()) setProviderConfig(previous)
      this.vault.replacePortableState(previousMemory)
      if (previousKnowledge && this.knowledge) this.knowledge.replacePortableState(previousKnowledge)
      for (const id of createdTaskIds) await this.runtime.removeTask(id).catch(() => undefined)
      for (const task of touchedExisting) {
        await this.runtime.updateTask(task.id, taskPatch(task)).catch(() => undefined)
      }
      throw error
    }
  }
}
