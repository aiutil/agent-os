import { extname } from 'node:path'
import type { RuntimeAttachmentCapabilities } from '../../../shared/types/runtime'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff'])

export function isImageAttachment(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).slice(1).toLowerCase())
}

/**
 * 在启动 Agent 前 fail closed，防止渠道/UI 已接受附件但 adapter 静默丢弃。
 */
export function assertAttachmentsSupported(
  agentName: string,
  capabilities: RuntimeAttachmentCapabilities,
  files?: string[]
): void {
  if (!files?.length) return
  if (!capabilities.images && !capabilities.files) {
    throw new Error(`[ATTACHMENT_UNSUPPORTED] ${agentName} 不支持附件`)
  }
  if (capabilities.maxFiles != null && files.length > capabilities.maxFiles) {
    throw new Error(
      `[ATTACHMENT_LIMIT] ${agentName} 每次最多接收 ${capabilities.maxFiles} 个附件`
    )
  }
  for (const file of files) {
    const image = isImageAttachment(file)
    if (image && !capabilities.images) {
      throw new Error(`[ATTACHMENT_UNSUPPORTED] ${agentName} 不支持图片附件`)
    }
    if (!image && !capabilities.files) {
      throw new Error(`[ATTACHMENT_UNSUPPORTED] ${agentName} 仅支持图片附件`)
    }
    if (capabilities.allowedExtensions?.length) {
      const extension = extname(file).slice(1).toLowerCase()
      if (!capabilities.allowedExtensions.includes(extension)) {
        throw new Error(`[ATTACHMENT_UNSUPPORTED] ${agentName} 不支持 .${extension || '?'} 附件`)
      }
    }
  }
}
