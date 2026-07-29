// SPEC-034 Step 2：消息渠道入站附件的受限临时存储。
// 平台 transport 负责鉴权下载；本模块统一执行数量/大小/文件名/权限/清理门禁。

import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { Readable } from 'node:stream'

export const MAX_CHANNEL_ATTACHMENTS = 5
export const MAX_CHANNEL_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_CHANNEL_ATTACHMENTS_TOTAL_BYTES = 50 * 1024 * 1024
export const STALE_CHANNEL_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1_000
const CHANNEL_ATTACHMENT_PREFIX = 'agentos-channel-'

export interface AttachmentPayload {
  buffer: Buffer
  filename?: string
  mimeType?: string
}

export interface AttachmentCandidate {
  kind: 'image' | 'file' | 'voice' | 'video'
  filename?: string
  mimeType?: string
  declaredBytes?: number
  load(maxBytes: number): Promise<AttachmentPayload>
}

export interface MaterializedAttachments {
  files: string[]
  cleanup(): Promise<void>
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/json': '.json',
  'application/zip': '.zip'
}

function fallbackExtension(kind: AttachmentCandidate['kind'], mimeType?: string): string {
  const normalized = mimeType?.split(';', 1)[0].trim().toLowerCase()
  if (normalized && MIME_EXTENSIONS[normalized]) return MIME_EXTENSIONS[normalized]
  if (kind === 'image') return '.jpg'
  if (kind === 'voice') return '.ogg'
  if (kind === 'video') return '.mp4'
  return '.bin'
}

export function safeAttachmentFilename(
  input: string | undefined,
  index: number,
  kind: AttachmentCandidate['kind'],
  mimeType?: string
): string {
  const pathless = basename((input || '').replace(/\\/g, '/'))
  const withoutControls = [...pathless]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
  const cleaned = withoutControls
    .replace(/[/:*?"<>|]/g, '_')
    .trim()
  const fallback = `${kind}${fallbackExtension(kind, mimeType)}`
  const chosen = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
  const extension = extname(chosen).slice(0, 16)
  const stemLimit = Math.max(1, 96 - extension.length)
  const stem = basename(chosen, extension).slice(0, stemLimit) || kind
  return `${String(index + 1).padStart(2, '0')}-${stem}${extension || fallbackExtension(kind, mimeType)}`
}

function assertDeclaredSize(bytes: number | undefined): void {
  if (bytes === undefined) return
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('附件声明大小无效')
  if (bytes > MAX_CHANNEL_ATTACHMENT_BYTES) {
    throw new Error(`单个附件不能超过 ${MAX_CHANNEL_ATTACHMENT_BYTES / 1024 / 1024} MiB`)
  }
}

export async function materializeAttachments(candidates: AttachmentCandidate[]): Promise<MaterializedAttachments | null> {
  if (!candidates.length) return null
  if (candidates.length > MAX_CHANNEL_ATTACHMENTS) {
    throw new Error(`每条消息最多处理 ${MAX_CHANNEL_ATTACHMENTS} 个附件`)
  }
  for (const candidate of candidates) assertDeclaredSize(candidate.declaredBytes)
  const declaredTotal = candidates.reduce((total, candidate) => total + (candidate.declaredBytes ?? 0), 0)
  if (declaredTotal > MAX_CHANNEL_ATTACHMENTS_TOTAL_BYTES) {
    throw new Error(`附件合计不能超过 ${MAX_CHANNEL_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024} MiB`)
  }

  const directory = await mkdtemp(join(tmpdir(), CHANNEL_ATTACHMENT_PREFIX))
  await chmod(directory, 0o700)
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    await rm(directory, { recursive: true, force: true })
  }

  try {
    const files: string[] = []
    let totalBytes = 0
    for (const [index, candidate] of candidates.entries()) {
      const payload = await candidate.load(MAX_CHANNEL_ATTACHMENT_BYTES)
      if (!Buffer.isBuffer(payload.buffer)) throw new Error('平台附件下载结果不是二进制数据')
      if (payload.buffer.length > MAX_CHANNEL_ATTACHMENT_BYTES) {
        throw new Error(`单个附件不能超过 ${MAX_CHANNEL_ATTACHMENT_BYTES / 1024 / 1024} MiB`)
      }
      totalBytes += payload.buffer.length
      if (totalBytes > MAX_CHANNEL_ATTACHMENTS_TOTAL_BYTES) {
        throw new Error(`附件合计不能超过 ${MAX_CHANNEL_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024} MiB`)
      }
      const filename = safeAttachmentFilename(
        payload.filename || candidate.filename,
        index,
        candidate.kind,
        payload.mimeType || candidate.mimeType
      )
      const filePath = join(directory, filename)
      await writeFile(filePath, payload.buffer, { flag: 'wx', mode: 0o600 })
      files.push(filePath)
    }
    return { files, cleanup }
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}

/** 应用异常退出无法执行回合 cleanup；启动时只清理超过 24h 的本产品临时目录。 */
export async function cleanupStaleChannelAttachments(
  now = Date.now(),
  maxAgeMs = STALE_CHANNEL_ATTACHMENT_AGE_MS
): Promise<number> {
  const root = tmpdir()
  const entries = await readdir(root, { withFileTypes: true })
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(CHANNEL_ATTACHMENT_PREFIX)) continue
    const path = join(root, entry.name)
    try {
      const info = await lstat(path)
      if (now - info.mtimeMs < maxAgeMs) continue
      await rm(path, { recursive: true, force: true })
      removed += 1
    } catch {
      // 清理是最佳努力；权限/并发删除不影响消息网关启动。
    }
  }
  return removed
}

export async function responseToLimitedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`附件下载返回 HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('附件超过允许大小')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > maxBytes) {
        await reader.cancel('attachment too large')
        throw new Error('附件超过允许大小')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

export async function nodeStreamToLimitedBuffer(
  stream: Readable,
  maxBytes: number,
  timeoutMs = 30_000
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  const timeout = timeoutMs > 0
    ? setTimeout(() => stream.destroy(new Error('附件下载超时')), timeoutMs)
    : undefined
  timeout?.unref()
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
      total += chunk.length
      if (total > maxBytes) throw new Error('附件超过允许大小')
      chunks.push(chunk)
    }
  } catch (error) {
    stream.destroy()
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  return Buffer.concat(chunks, total)
}

export function filenameFromContentDisposition(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (utf8) {
    try {
      return decodeURIComponent(utf8)
    } catch {
      return utf8
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1]
}
