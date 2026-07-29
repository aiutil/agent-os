import type { AnalyticsConfig } from '@shared/types'

export interface BuildAnalyticsConfigInput {
  isPackaged: boolean
  trackingEnabled: boolean
  productionToken: string
  developmentToken: string
  installId: string
  appVersion: string
  platform: NodeJS.Platform
  arch: string
}

export function buildAnalyticsConfig(input: BuildAnalyticsConfigInput): AnalyticsConfig {
  const environment = input.isPackaged ? 'production' : 'development'
  const token = (input.isPackaged ? input.productionToken : input.developmentToken).trim()
  const enabled = input.trackingEnabled && Boolean(token)
  return {
    enabled,
    trackingEnabled: input.trackingEnabled,
    environment,
    token,
    installId: input.installId,
    appVersion: input.appVersion,
    platform: input.platform,
    arch: input.arch,
    ...(!input.trackingEnabled
      ? { disabledReason: 'user_opted_out' as const }
      : !token
        ? {
            disabledReason: input.isPackaged
              ? ('missing_production_token' as const)
              : ('missing_development_token' as const)
          }
        : {})
  }
}
