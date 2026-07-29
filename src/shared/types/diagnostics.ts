export type DataPlaneHealthStatus = 'untested' | 'ok' | 'partial' | 'drifted'

export interface DataPlaneHealth {
  toolId: string
  cliVersion: string
  status: DataPlaneHealthStatus
  sampleErrors: string[]
}
