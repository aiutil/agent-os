export interface AttachmentPreview {
  dataUrl: string
  width: number
  height: number
}

const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp'
])

export function isPreviewableAttachmentImage(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot >= 0 && PREVIEWABLE_IMAGE_EXTENSIONS.has(base.slice(dot).toLowerCase())
}

export function fitAttachmentPreviewSize(
  width: number,
  height: number,
  maxEdge = 160
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 }
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}
