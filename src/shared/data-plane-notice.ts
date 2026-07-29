import { tr } from './i18n'
import type { DataPlaneHealth } from './types/diagnostics'

export function getDataPlaneDegradationNotice(
  items: DataPlaneHealth[]
): string[] {
  return items.flatMap((item) => {
    if (item.status === 'drifted') return [tr('system.dataPlane.drifted', { toolId: item.toolId })]
    if (item.status === 'partial') return [tr('system.dataPlane.partial', { toolId: item.toolId })]
    return []
  })
}
