import type {
  LifecycleJob,
  LifecycleJobKind,
  MirrorSettings,
  ProviderConfig,
  ProviderConfigView
} from '@shared/types'
import { getAdapter } from '../adapters/registry'
import { scanOne } from '../discovery/discovery'
import {
  getMirrorSettings,
  getProviderConfig,
  setMirrorSettings,
  setProviderConfig
} from '../../store/app-store'
import {
  buildLifecycleCommand,
  buildProviderEnvironment,
  validateProviderConfig
} from './config'
import { LifecycleJobManager } from './jobs'

interface LifecycleServiceOptions {
  onJobProgress?(job: LifecycleJob): void
  onDiscoveryRefresh?(): Promise<void> | void
}

export class LifecycleService {
  private readonly jobs: LifecycleJobManager

  constructor(private readonly options: LifecycleServiceOptions = {}) {
    this.jobs = new LifecycleJobManager({
      resolveCommand: (toolId, kind) => {
        const adapter = getAdapter(toolId)
        if (!adapter) throw new Error(`未知的 CLI 适配器：${toolId}`)
        return buildLifecycleCommand(adapter, kind, getMirrorSettings())
      },
      environment: () => {
        const proxy = getMirrorSettings().httpsProxy?.trim()
        const environment: Record<string, string> = {}
        if (proxy) {
          environment.HTTPS_PROXY = proxy
          environment.https_proxy = proxy
        }
        return environment
      },
      onProgress: (job) => this.options.onJobProgress?.(job),
      onSucceeded: async (toolId) => {
        await scanOne(toolId)
        await this.options.onDiscoveryRefresh?.()
      }
    })
  }

  startJob(toolId: string, kind: LifecycleJobKind): string {
    return this.jobs.start(toolId, kind)
  }

  getJob(jobId: string): LifecycleJob | null {
    return this.jobs.get(jobId)
  }

  cancelJob(jobId: string): boolean {
    return this.jobs.cancel(jobId)
  }

  getMirrorSettings(): MirrorSettings {
    return getMirrorSettings()
  }

  setMirrorSettings(settings: MirrorSettings): void {
    setMirrorSettings({
      ...(settings.npmRegistry?.trim() ? { npmRegistry: settings.npmRegistry.trim() } : {}),
      ...(settings.httpsProxy?.trim() ? { httpsProxy: settings.httpsProxy.trim() } : {})
    })
  }

  getProvider(toolId: string): ProviderConfigView {
    const adapter = getAdapter(toolId)
    if (!adapter) throw new Error(`未知的 CLI 适配器：${toolId}`)
    const config = getProviderConfig(toolId)
    return {
      toolId,
      hasApiKey: Boolean(config.apiKey),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.model ? { model: config.model } : {}),
      injectedEnvNames: Object.values(adapter.providerEnvironment ?? {})
    }
  }

  setProvider(input: ProviderConfig): ProviderConfigView {
    validateProviderConfig(input)
    const previous = getProviderConfig(input.toolId)
    setProviderConfig({
      toolId: input.toolId,
      apiKey: input.apiKey === undefined ? previous.apiKey : input.apiKey.trim() || undefined,
      baseUrl: input.baseUrl?.trim() || undefined,
      model: input.model?.trim() || undefined
    })
    return this.getProvider(input.toolId)
  }

  providerEnvironment(toolId: string): Record<string, string> {
    const adapter = getAdapter(toolId)
    return adapter ? buildProviderEnvironment(adapter, getProviderConfig(toolId)) : {}
  }

  providerModel(toolId: string): string | undefined {
    return getProviderConfig(toolId).model
  }
}
