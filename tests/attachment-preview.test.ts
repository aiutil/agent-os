import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  fitAttachmentPreviewSize,
  isPreviewableAttachmentImage
} from '../src/shared/attachment-preview'
import { AttachmentPreviewRegistry } from '../src/main/domains/attachments/preview'

describe('SPEC-043 attachment preview', () => {
  it('只把安全的位图扩展名识别为可预览图片', () => {
    expect(isPreviewableAttachmentImage('/tmp/PHOTO.PNG')).toBe(true)
    expect(isPreviewableAttachmentImage('/tmp/photo.webp')).toBe(true)
    expect(isPreviewableAttachmentImage('/tmp/vector.svg')).toBe(false)
    expect(isPreviewableAttachmentImage('/tmp/readme.md')).toBe(false)
  })

  it('按比例缩到最长边 160px 且不放大小图', () => {
    expect(fitAttachmentPreviewSize(1200, 600)).toEqual({ width: 160, height: 80 })
    expect(fitAttachmentPreviewSize(400, 800)).toEqual({ width: 80, height: 160 })
    expect(fitAttachmentPreviewSize(80, 40)).toEqual({ width: 80, height: 40 })
  })

  it('拒绝未授权、相对路径和非图片，只调用已授权图片的 loader', () => {
    const registry = new AttachmentPreviewRegistry()
    const approved = resolve('/tmp/approved.png')
    const loader = vi.fn(() => ({ dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 }))

    expect(registry.approve('relative.png')).toBe(false)
    expect(registry.preview(approved, loader)).toBeNull()
    registry.approve(approved)
    expect(registry.preview(approved, loader)?.dataUrl).toContain('data:image/png')
    registry.approve(resolve('/tmp/readme.txt'))
    expect(registry.preview(resolve('/tmp/readme.txt'), loader)).toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('删除会话时只撤销该暂存目录许可', () => {
    const registry = new AttachmentPreviewRegistry()
    const first = resolve('/tmp/attachments/session-a/one.png')
    const sibling = resolve('/tmp/attachments/session-ab/two.png')
    const loader = vi.fn(() => ({ dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 }))
    registry.approveMany([first, sibling])

    registry.revokeUnder(resolve('/tmp/attachments/session-a'))
    expect(registry.preview(first, loader)).toBeNull()
    expect(registry.preview(sibling, loader)).not.toBeNull()
  })

  it('输入区同时包含图片缩略图、文件降级和 blob URL 回收', () => {
    const component = readFileSync(
      'src/renderer/src/v3/sections/chat/AttachmentPreviewItem.tsx',
      'utf8'
    )
    const css = readFileSync('src/renderer/src/v3/v3.css', 'utf8')
    const html = readFileSync('src/renderer/index.html', 'utf8')
    const ipc = readFileSync('src/main/ipc/registerIpc.ts', 'utf8')
    const selectFileHandler =
      /CHANNELS\.app\.selectFile,([\s\S]*?)\/\/ SPEC-038：附件暂存/.exec(ipc)?.[1] ?? ''
    const selectDirectoryHandler =
      /CHANNELS\.app\.selectDirectory,([\s\S]*?)CHANNELS\.app\.selectFile/.exec(ipc)?.[1] ?? ''

    expect(component).toContain('.preview(attachment.path)')
    expect(component).toContain('URL.createObjectURL')
    expect(component).toContain('URL.revokeObjectURL')
    expect(component).toContain('aria-label={removeLabel}')
    expect(component).toContain('chat-attached-chip')
    expect(css).toContain('.chat-attached-thumbnail')
    expect(html).toContain("img-src 'self' data: blob:")
    expect(selectFileHandler).toContain('attachmentPreviews.approve(path)')
    expect(selectDirectoryHandler).not.toContain('attachmentPreviews.approve')
  })
})
