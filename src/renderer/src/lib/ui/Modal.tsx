// 统一弹窗基元（SPEC-005 v2 / SPEC-021 焦点契约）。
// 遮罩点击关闭、ESC 关闭、焦点陷阱、打开聚焦首元素、关闭恢复焦点、进出动画、可选标题/页脚、滚动锁。

import { useId, useRef, type ReactNode } from 'react'
import { useT } from '../i18n'
import { IconButton, CloseIcon } from './IconButton'
import { useDialogFocus, useScrollLock } from './useDialogFocus'

export type ModalSize = 'sm' | 'md' | 'lg'

interface ModalProps {
  open: boolean
  onClose(): void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: ModalSize
  closeOnBackdrop?: boolean
  /** 关闭右上角关闭按钮（无标题弹窗自带关闭时用）。 */
  hideClose?: boolean
  /** 禁用所有关闭路径（ESC / 遮罩 / 关闭按钮）——用于确认 in-flight 期间防误关。 */
  disableClose?: boolean
  className?: string
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
  hideClose = false,
  disableClose = false,
  className
}: ModalProps): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const { t } = useT()

  useDialogFocus(containerRef, open, { onEscape: disableClose ? undefined : onClose })
  useScrollLock(open)

  if (!open) return null

  return (
    <div
      className="ui-modal-overlay"
      onMouseDown={(e) => {
        if (closeOnBackdrop && !disableClose && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={containerRef}
        className={`ui-modal ui-modal--${size}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        aria-label={title === undefined ? t('system.modal.dialogLabel') : undefined}
      >
        {(title !== undefined || !hideClose) && (
          <header className="ui-modal__head">
            <div id={titleId} className="ui-modal__title">
              {title}
            </div>
            {!hideClose && (
              <IconButton
                label={t('common.action.close')}
                size="sm"
                className="ui-modal__close"
                disabled={disableClose}
                onClick={onClose}
              >
                <CloseIcon />
              </IconButton>
            )}
          </header>
        )}
        <div className="ui-modal__body">{children}</div>
        {footer !== undefined && <footer className="ui-modal__foot">{footer}</footer>}
      </div>
    </div>
  )
}
