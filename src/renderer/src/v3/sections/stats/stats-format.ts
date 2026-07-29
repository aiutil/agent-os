import { localeFor } from '@shared/i18n'
import { getCurrentRendererLang } from '../../../lib/i18n'

export function humanizeStatsNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return new Intl.NumberFormat(localeFor(getCurrentRendererLang())).format(value)
}

export function formatEstimatedCost(
  value: number | null,
  hasUnpricedUsage: boolean
): string {
  if (value === null) return '—'
  const digits = value >= 10 ? 2 : 4
  return `$${value.toFixed(digits)}${hasUnpricedUsage ? '+' : ''}`
}
