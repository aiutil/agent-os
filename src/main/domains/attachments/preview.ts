import { isAbsolute, resolve, sep } from 'node:path'
import { isPreviewableAttachmentImage, type AttachmentPreview } from '@shared/attachment-preview'

export type AttachmentPreviewLoader = (path: string) => AttachmentPreview | null

/**
 * Renderer 只能预览经系统选择器、剪贴板或附件暂存明确授权过的路径。
 * 许可仅驻留当前主进程内存，不持久化，也不接受相对路径。
 */
export class AttachmentPreviewRegistry {
  private readonly approvedPaths = new Set<string>()

  approve(path: string): boolean {
    if (!isAbsolute(path)) return false
    this.approvedPaths.add(resolve(path))
    return true
  }

  approveMany(paths: string[]): void {
    for (const path of paths) this.approve(path)
  }

  preview(path: string, load: AttachmentPreviewLoader): AttachmentPreview | null {
    if (!isAbsolute(path)) return null
    const normalized = resolve(path)
    if (!this.approvedPaths.has(normalized) || !isPreviewableAttachmentImage(normalized))
      return null
    return load(normalized)
  }

  revokeUnder(directory: string): void {
    const normalizedDirectory = resolve(directory)
    const prefix = normalizedDirectory.endsWith(sep)
      ? normalizedDirectory
      : `${normalizedDirectory}${sep}`
    for (const path of this.approvedPaths) {
      if (path === normalizedDirectory || path.startsWith(prefix)) this.approvedPaths.delete(path)
    }
  }
}
