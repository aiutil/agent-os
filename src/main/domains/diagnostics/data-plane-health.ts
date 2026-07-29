import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { DataPlaneHealth } from '../../../shared/types/diagnostics'
import { getAdapter, listAdapters } from '../adapters/registry'
import { asRecord, asString } from '../adapters/storage-utils'

export interface DataPlaneAssessmentInput {
  toolId: string
  cliVersion: string
  support: 'full' | 'partial'
  totalLines: number
  parseErrors: number
  requiredFieldsPresent: boolean
  hasSample?: boolean
}

export function assessDataPlaneHealth(
  input: DataPlaneAssessmentInput
): DataPlaneHealth {
  if (input.support === 'partial') {
    return {
      toolId: input.toolId,
      cliVersion: input.cliVersion,
      status: 'partial',
      sampleErrors: ['该适配器仅支持会话定位，暂不支持详情解析']
    }
  }

  if (input.hasSample === false) {
    return {
      toolId: input.toolId,
      cliVersion: input.cliVersion,
      status: 'untested',
      sampleErrors: ['尚未发现可用于诊断的会话文件']
    }
  }

  const sampleErrors: string[] = []
  const errorRatio =
    input.totalLines === 0 ? 0 : input.parseErrors / input.totalLines
  if (errorRatio > 0.1) {
    sampleErrors.push(
      `解析错误比例 ${(errorRatio * 100).toFixed(1)}%，超过 10% 阈值`
    )
  }
  if (!input.requiredFieldsPresent) {
    sampleErrors.push('缺少 nativeSessionId 或 title')
  }

  return {
    toolId: input.toolId,
    cliVersion: input.cliVersion,
    status: sampleErrors.length > 0 ? 'drifted' : 'ok',
    sampleErrors
  }
}

export class DataPlaneHealthRegistry {
  private readonly entries = new Map<string, DataPlaneHealth>()

  record(health: DataPlaneHealth): void {
    this.entries.set(`${health.toolId}:${health.cliVersion}`, health)
  }

  clear(): void {
    this.entries.clear()
  }

  list(): DataPlaneHealth[] {
    return [...this.entries.values()].sort((a, b) => {
      const toolOrder = a.toolId.localeCompare(b.toolId)
      return toolOrder !== 0
        ? toolOrder
        : a.cliVersion.localeCompare(b.cliVersion)
    })
  }
}

const runtimeRegistry = new DataPlaneHealthRegistry()

export async function inspectDataPlaneFile(
  toolId: string,
  path: string
): Promise<DataPlaneHealth> {
  const storage = getAdapter(toolId)?.sessionStorage
  if (!storage?.parseTranscript || !storage.readMeta) {
    throw new Error(`${toolId} 没有可用的 transcript 解析能力`)
  }

  const cliVersion = await detectTranscriptVersion(toolId, path)
  try {
    const stream = storage.parseTranscript(path)
    for await (const message of stream) {
      // 健康检查只消费流，不保留消息，避免诊断操作放大内存。
      void message
    }
    const [summary, meta] = await Promise.all([
      stream.summary,
      storage.readMeta(path)
    ])
    const health = assessDataPlaneHealth({
      toolId,
      cliVersion,
      support: storage.support,
      totalLines: summary.totalLines,
      parseErrors: summary.parseErrors,
      requiredFieldsPresent: Boolean(meta.nativeSessionId && meta.title)
    })
    runtimeRegistry.record(health)
    return health
  } catch (error) {
    const health: DataPlaneHealth = {
      toolId,
      cliVersion,
      status: 'drifted',
      sampleErrors: [error instanceof Error ? error.message : String(error)]
    }
    runtimeRegistry.record(health)
    return health
  }
}

export async function refreshDataPlaneHealth(
  installedVersions: ReadonlyMap<string, string> = new Map()
): Promise<DataPlaneHealth[]> {
  runtimeRegistry.clear()
  for (const adapter of listAdapters()) {
    const storage = adapter.sessionStorage
    if (!storage) continue

    if (storage.support === 'partial') {
      runtimeRegistry.record(
        assessDataPlaneHealth({
          toolId: adapter.id,
          cliVersion: installedVersions.get(adapter.id) ?? 'unknown',
          support: 'partial',
          totalLines: 0,
          parseErrors: 0,
          requiredFieldsPresent: false
        })
      )
      continue
    }

    if (storage.scanTranscripts) {
      const cliVersion = installedVersions.get(adapter.id) ?? 'unknown'
      try {
        let sampleFound = false
        for await (const transcript of storage.scanTranscripts()) {
          sampleFound = true
          runtimeRegistry.record(
            assessDataPlaneHealth({
              toolId: adapter.id,
              cliVersion,
              support: 'full',
              totalLines: transcript.messages.length + transcript.parseErrors,
              parseErrors: transcript.parseErrors,
              requiredFieldsPresent: Boolean(
                transcript.nativeSessionId && transcript.title
              )
            })
          )
          break
        }
        if (!sampleFound) {
          runtimeRegistry.record(
            assessDataPlaneHealth({
              toolId: adapter.id,
              cliVersion,
              support: 'full',
              totalLines: 0,
              parseErrors: 0,
              requiredFieldsPresent: false,
              hasSample: false
            })
          )
        }
      } catch (error) {
        runtimeRegistry.record({
          toolId: adapter.id,
          cliVersion,
          status: 'drifted',
          sampleErrors: [error instanceof Error ? error.message : String(error)]
        })
      }
      continue
    }

    const latest = storage
      .rootDirs()
      .flatMap((root) => storage.listSessionFiles(root))
      .sort((a, b) => b.mtime - a.mtime)[0]
    if (!latest) {
      runtimeRegistry.record(
        assessDataPlaneHealth({
          toolId: adapter.id,
          cliVersion: installedVersions.get(adapter.id) ?? 'unknown',
          support: 'full',
          totalLines: 0,
          parseErrors: 0,
          requiredFieldsPresent: false,
          hasSample: false
        })
      )
      continue
    }

    await inspectDataPlaneFile(adapter.id, latest.path)
  }

  return runtimeRegistry.list()
}

async function detectTranscriptVersion(
  toolId: string,
  path: string
): Promise<string> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      const record = asRecord(JSON.parse(line))
      if (!record) continue
      if (toolId === 'claude') {
        const version = asString(record.version)
        if (version) {
          lines.close()
          return version
        }
      }
      if (toolId === 'codex' && record.type === 'session_meta') {
        const version = asString(asRecord(record.payload)?.cli_version)
        if (version) {
          lines.close()
          return version
        }
      }
    } catch {
      // 版本探测跳过坏行，完整坏行比例由解析器统计。
    }
  }
  return 'unknown'
}
