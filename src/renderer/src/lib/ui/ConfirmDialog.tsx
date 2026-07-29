// 确认对话框（SPEC-005 v2 / SPEC-021 反馈）。替代散落的 window.confirm / 自写确认弹窗。
// loading 期间锁定所有关闭路径（ESC/遮罩/关闭/取消），保证破坏性确认原子完成；
// 确认按钮文案切到「…中…」并以 aria-live 公告，满足「loading 文案以 … 结尾 + 关键反馈走 aria-live」。

import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { Modal } from './Modal'
import { Button } from './Button'

interface ConfirmDialogProps {
  open: boolean
  title?: string
  message: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  loading?: boolean
  onConfirm(): void
  onCancel(): void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  cancelText,
  danger = false,
  loading = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element | null {
  const { t } = useT()
  const resolvedTitle = title ?? t('common.action.confirm')
  const resolvedConfirm = confirmText ?? t('common.action.confirm')
  const resolvedCancel = cancelText ?? t('common.action.cancel')
  return (
    <Modal open={open} onClose={onCancel} title={resolvedTitle} size="sm" disableClose={loading}>
      <div className="ui-confirm__msg">{message}</div>
      <div className="ui-confirm__foot" role="status" aria-live="polite">
        <Button variant="ghost" disabled={loading} onClick={onCancel}>
          {resolvedCancel}
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
          {loading ? t('system.confirm.loadingSuffix', { text: resolvedConfirm }) : resolvedConfirm}
        </Button>
      </div>
    </Modal>
  )
}
