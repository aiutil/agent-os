export type LifecycleJobKind = 'install' | 'update'
export type LifecycleJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type LifecycleDiagnosisCategory = 'network' | 'permission' | 'path' | 'runtime' | 'unknown'

export interface LifecycleDiagnosis {
  category: LifecycleDiagnosisCategory
  evidence: string
  suggestion: string
}

export interface LifecycleJob {
  id: string
  toolId: string
  kind: LifecycleJobKind
  status: LifecycleJobStatus
  command: string
  logTail: string
  createdAt: string
  updatedAt: string
  exitCode?: number
  diagnosis?: LifecycleDiagnosis
}

export interface MirrorSettings {
  npmRegistry?: string
  httpsProxy?: string
}

export interface ProviderConfig {
  toolId: string
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface ProviderConfigView {
  toolId: string
  hasApiKey: boolean
  baseUrl?: string
  model?: string
  injectedEnvNames: string[]
}
