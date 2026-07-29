export interface SessionFileRef {
  path: string
  nativeSessionId: string
  toolId: string
  cwd?: string
  createdAt?: number
  mtime: number
}

export interface NormalizedTranscript {
  nativeSessionId: string
  toolId: string
  cwd: string | null
  title: string
  startedAt: string | null
  lastActivityAt: string | null
  messages: NormalizedMessage[]
  parseErrors: number
}

export interface NormalizedMessage {
  seq: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  toolName?: string
  ts?: string
  raw?: { kind: string }
}

export interface TranscriptParseSummary {
  totalLines: number
  parseErrors: number
}

export interface TranscriptMessageStream extends AsyncIterable<NormalizedMessage> {
  summary: Promise<TranscriptParseSummary>
  usageFacts: Promise<TranscriptUsageFact[]>
}

export interface TranscriptReadOptions {
  /** 必须位于完整 JSONL 行边界；用于 append-only 文件增量消费。 */
  startOffset?: number
}

export interface AdapterSessionStorage {
  /** 默认 true；完整 JSON、SQLite 快照等来源必须设为 false。 */
  incremental?: boolean
  rootDirs(): string[]
  locateDir(cwd: string): string | null
  listSessionFiles(dir: string): SessionFileRef[]
  /**
   * SQLite 等非“一文件一会话”来源通过此入口提供可定位的会话快照。
   * 未实现时定位器回退到 rootDirs/listSessionFiles。
   */
  listNativeSessions?(): Promise<SessionFileRef[]> | SessionFileRef[]
  /**
   * 数据库等非“一文件一会话”来源使用此入口产出完整会话快照。
   * 索引层只消费 NormalizedTranscript，不感知私有存储结构。
   */
  scanTranscripts?(): AsyncIterable<NormalizedTranscript>
  parseTranscript?(path: string, options?: TranscriptReadOptions): TranscriptMessageStream
  readMeta?(
    path: string
  ): Promise<Pick<NormalizedTranscript, 'nativeSessionId' | 'cwd' | 'title' | 'startedAt'>>
  support: 'full' | 'partial'
}
import type { TranscriptUsageFact } from './stats'
