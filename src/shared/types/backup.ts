import type { Lang } from '../i18n'
import type { MirrorSettings } from './lifecycle'
import type { DurableMemory, MemorySettings } from './memory'
import type { AgentTask } from './task'

export interface PortableProviderPreference {
  toolId: string
  baseUrl?: string
  model?: string
}

export interface PortableBackupV1 {
  schemaVersion: 1
  product: 'Agent OS'
  exportedAt: string
  sourceVersion: string
  preferences: {
    language: Lang
    gamificationEnabled: boolean
    mirrorSettings: MirrorSettings
    providers: PortableProviderPreference[]
  }
  memory: {
    persona: string
    settings: MemorySettings
    items: DurableMemory[]
  }
  tasks: AgentTask[]
}

export interface PortableBackupSummary {
  sourceVersion: string
  exportedAt: string
  memories: number
  tasks: number
  providers: number
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
  schedulesPaused: number
}
