import type { Lang, LanguagePreference } from '../i18n'
import type { MirrorSettings } from './lifecycle'
import type { DurableMemory, MemorySettings } from './memory'
import type { KnowledgeArticle, KnowledgeComment } from './knowledge'
import type { AgentTask } from './task'

export interface PortableProviderPreference {
  toolId: string
  baseUrl?: string
  model?: string
}

/** 正文随备份保存，导入时在目标机重新落为 ~/.agent-os/knowledge 的 Markdown 文件。 */
export type PortableKnowledgeArticle = Omit<KnowledgeArticle, 'path'>

export interface PortableKnowledgeState {
  articles: PortableKnowledgeArticle[]
  comments: KnowledgeComment[]
}

export interface PortableBackupV1 {
  schemaVersion: 1
  product: 'Agent OS'
  exportedAt: string
  sourceVersion: string
  preferences: {
    language: Lang
    /** 可选以兼容 0.4.0 前只保存生效语言的备份。 */
    languagePreference?: LanguagePreference
    gamificationEnabled: boolean
    mirrorSettings: MirrorSettings
    providers: PortableProviderPreference[]
  }
  memory: {
    persona: string
    settings: MemorySettings
    items: DurableMemory[]
  }
  /** 可选以兼容 SPEC-046 前导出的 schema v1 备份。 */
  knowledge?: PortableKnowledgeState
  tasks: AgentTask[]
}

export interface PortableBackupSummary {
  sourceVersion: string
  exportedAt: string
  memories: number
  tasks: number
  providers: number
  knowledgeArticles?: number
  schedulesWillBePaused: number
  credentialsExcluded: true
}

export interface PortableBackupExportResult {
  cancelled: boolean
  path?: string
  summary?: PortableBackupSummary
}

export interface PortableBackupPreviewResult {
  cancelled: boolean
  /** 系统文件选择器签发的一次性短期授权；renderer 不持有任意文件路径。 */
  approvalToken?: string
  summary?: PortableBackupSummary
}

export interface PortableBackupImportResult {
  importedMemories: number
  importedTasks: number
  importedProviders: number
  importedKnowledgeArticles?: number
  schedulesPaused: number
}
