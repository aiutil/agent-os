// SPEC-038 附件暂存层单测（纯 node，rootDir 注入）。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteAttachments,
  pruneOrphanedAttachments,
  stageAttachment
} from '../src/main/domains/attachments/store'

describe('attachments store (SPEC-038)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'att-store-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('stageAttachment 写盘并返回绝对路径 + displayName + bytes，权限 0o600', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const staged = stageAttachment(root, 'sess-1', 'photo.png', bytes)
    expect(staged.path).toMatch(/[\\/\\]sess-1[\\/\\].*\.png$/)
    expect(staged.displayName).toBe('photo.png')
    expect(staged.bytes).toBe(4)
    expect(readFileSync(staged.path)).toEqual(Buffer.from(bytes))
    expect(statSync(staged.path).mode & 0o777).toBe(0o600)
  })

  it('stageAttachment 连续两次路径不碰撞（uuid 文件名）', () => {
    const a = stageAttachment(root, 's', 'x.png', new Uint8Array([1]))
    const b = stageAttachment(root, 's', 'x.png', new Uint8Array([2]))
    expect(a.path).not.toBe(b.path)
  })

  it('deleteAttachments 删除 session 目录，对不存在 session 不抛', () => {
    stageAttachment(root, 'sess-2', 'a.txt', new Uint8Array([1]))
    expect(existsSync(join(root, 'sess-2'))).toBe(true)
    deleteAttachments(root, 'sess-2')
    expect(existsSync(join(root, 'sess-2'))).toBe(false)
    expect(() => deleteAttachments(root, 'never-existed')).not.toThrow()
  })

  it('pruneOrphanedAttachments 清掉孤儿、保留有效 session 目录', () => {
    stageAttachment(root, 'keep', 'a.png', new Uint8Array([1]))
    stageAttachment(root, 'orphan1', 'b.png', new Uint8Array([2]))
    stageAttachment(root, 'orphan2', 'c.png', new Uint8Array([3]))
    const removed = pruneOrphanedAttachments(root, new Set(['keep']))
    expect(removed).toBe(2)
    expect(readdirSync(root)).toEqual(['keep'])
  })

  it('pruneOrphanedAttachments 根目录不存在时返回 0 且不抛', () => {
    expect(pruneOrphanedAttachments(join(root, 'nope'), new Set())).toBe(0)
  })
})
