import { useNotificationStore } from '../stores/notificationStore'
import { CloseIcon, IconButton } from '../lib/ui'
import { useT } from '../lib/i18n'
import './ToastViewport.css'

export function ToastViewport(): React.JSX.Element | null {
  const items = useNotificationStore((s) => s.items)
  const dismiss = useNotificationStore((s) => s.dismiss)
  const { t } = useT()

  if (items.length === 0) return null

  return (
    <div className="toast-viewport" role="status" aria-live="polite" aria-relevant="additions text">
      {items.map((item) => (
        <div key={item.id} className={`toast-item toast-item--${item.tone}`}>
          <span className="toast-item__dot" aria-hidden="true" />
          <span className="toast-item__message">{item.message}</span>
          <IconButton label={t('workbench.notice.close')} size="sm" onClick={() => dismiss(item.id)}>
            <CloseIcon />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
