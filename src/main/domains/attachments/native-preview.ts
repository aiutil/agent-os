import { nativeImage } from 'electron'
import { statSync } from 'node:fs'
import { fitAttachmentPreviewSize, type AttachmentPreview } from '@shared/attachment-preview'

const MAX_PREVIEW_SOURCE_BYTES = 25 * 1024 * 1024

export function loadNativeAttachmentPreview(path: string): AttachmentPreview | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_PREVIEW_SOURCE_BYTES) return null

    const source = nativeImage.createFromPath(path)
    if (source.isEmpty()) return null
    const sourceSize = source.getSize()
    const size = fitAttachmentPreviewSize(sourceSize.width, sourceSize.height)
    const thumbnail =
      size.width === sourceSize.width && size.height === sourceSize.height
        ? source
        : source.resize({ width: size.width, height: size.height, quality: 'good' })
    if (thumbnail.isEmpty()) return null

    return {
      dataUrl: thumbnail.toDataURL(),
      ...thumbnail.getSize()
    }
  } catch {
    return null
  }
}
