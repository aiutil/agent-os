// 会话附件暂存（SPEC-038）。
// 粘贴图片 / 拖拽文件等内存字节物化到磁盘，得到绝对路径后交给 adapter。
// selectFile 选中的用户自有文件不经过这里（adapter 直接吃原路径，零回归）。
// 暂存目录约定 userData/attachments/<sessionId>/；session 删除时清理，启动时 prune 孤儿。
// 纯 node 实现（不 import electron），rootDir 由调用方注入以便单测。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

export interface StagedAttachment {
  /** 暂存绝对路径，提交给 sendTurn → adapter。 */
  path: string
  /** 保留用户原始文件名，供 UI chip 展示。 */
  displayName: string
  /** 字节数，供 UI / 上限校验。 */
  bytes: number
}

/** 无扩展名时按常见图片/文档后缀兜底识别（粘贴图片 filename 常带 .png，但防御空名）。 */
function inferExt(filename: string): string {
  const ext = extname(filename)
  if (ext) return ext
  const lower = filename.toLowerCase()
  for (const candidate of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md']) {
    if (lower.endsWith(candidate)) return candidate
  }
  return ''
}

/**
 * 把内存字节物化为附件文件。
 * 磁盘文件名 <uuid><ext>（避免碰撞、规避用户文件名里的非法字符 / 路径穿越）；
 * mode 0o600（owner-only，复用 FileSessionRepository 原子写约定）。
 */
export function stageAttachment(
  rootDir: string,
  sessionId: string,
  filename: string,
  bytes: Uint8Array
): StagedAttachment {
  const dir = join(rootDir, sessionId)
  mkdirSync(dir, { recursive: true })
  const ext = inferExt(filename)
  const abs = join(dir, `${randomUUID()}${ext}`)
  writeFileSync(abs, bytes, { mode: 0o600 })
  return {
    path: abs,
    displayName: filename?.trim() || `attachment${ext}`,
    bytes: bytes.byteLength
  }
}

/** 删除某 session 的全部暂存附件（best-effort，不抛）。 */
export function deleteAttachments(rootDir: string, sessionId: string): void {
  rmSync(join(rootDir, sessionId), { recursive: true, force: true })
}

/**
 * 启动兜底：删除磁盘上存在、但已不在有效 session 集合里的附件目录（崩溃残留孤儿）。
 * 返回清理的目录数。
 */
export function pruneOrphanedAttachments(rootDir: string, validSessionIds: Set<string>): number {
  if (!existsSync(rootDir)) return 0
  let removed = 0
  for (const name of readdirSync(rootDir)) {
    if (validSessionIds.has(name)) continue
    rmSync(join(rootDir, name), { recursive: true, force: true })
    removed += 1
  }
  return removed
}
