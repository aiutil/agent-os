import { useEffect, useState } from 'react'
import { isPreviewableAttachmentImage } from '@shared/attachment-preview'
import { useT } from '../../../lib/i18n'

export interface AttachmentPreviewDescriptor {
  displayName: string
  path?: string
  bytes?: Uint8Array
}

function FileIcon(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="M5.5 1H3A1 1 0 0 0 2 2v6a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4.5L5.5 1Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M5.5 1v3.5H9" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

export function AttachmentPreviewItem({
  attachment,
  onRemove
}: {
  attachment: AttachmentPreviewDescriptor
  onRemove(): void
}): React.JSX.Element {
  const { t } = useT()
  const previewable = isPreviewableAttachmentImage(attachment.displayName)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => {
    let active = true
    let objectUrl: string | undefined
    setPreviewUrl(null)
    setPreviewFailed(false)
    if (!previewable) return

    try {
      if (attachment.bytes?.byteLength) {
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(attachment.bytes)]))
        setPreviewUrl(objectUrl)
      } else if (attachment.path) {
        void window.agentOs.attachments
          .preview(attachment.path)
          .then((preview) => {
            if (active) setPreviewUrl(preview?.dataUrl ?? null)
          })
          .catch(() => {
            if (active) setPreviewFailed(true)
          })
      }
    } catch {
      setPreviewFailed(true)
    }

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.bytes, attachment.path, previewable])

  const removeLabel = `${t('chat.attach.removeFile')}：${attachment.displayName}`
  if (previewable && previewUrl && !previewFailed) {
    return (
      <div className="chat-attached-thumbnail" title={attachment.displayName}>
        <img
          className="chat-attached-thumbnail__image"
          src={previewUrl}
          alt=""
          onError={() => setPreviewFailed(true)}
        />
        <span className="chat-attached-thumbnail__name">{attachment.displayName}</span>
        <button
          type="button"
          className="chat-attached-thumbnail__remove"
          onClick={onRemove}
          title={removeLabel}
          aria-label={removeLabel}
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <span className="chat-attached-chip" title={attachment.displayName}>
      <FileIcon />
      <span className="chat-attached-chip__name">{attachment.displayName}</span>
      <button
        type="button"
        className="chat-attached-chip__remove"
        onClick={onRemove}
        title={removeLabel}
        aria-label={removeLabel}
      >
        ×
      </button>
    </span>
  )
}
