// 全局「发现新版本」浮层（对齐 agent-life AppUpdateToast）。
// 由 V3App 订阅 onUpdateState/onUpdateProgress 后下发 state；样式全部走 tokens.css 变量。

import { useCallback, useState } from 'react'
import type { UpdateState } from '@shared/types'
import { useT } from '@renderer/lib/i18n'

interface UpdateToastProps {
  state: UpdateState
  onDismiss: () => void
}

const btnBase: React.CSSProperties = {
  height: 30,
  padding: '0 14px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  font: 'inherit',
  border: 'none'
}

export function UpdateToast({ state, onDismiss }: UpdateToastProps): React.JSX.Element | null {
  const { t } = useT()
  const [busy, setBusy] = useState(false)

  const handleDownload = useCallback(async () => {
    if (busy || state.status === 'downloading') return
    setBusy(true)
    try {
      await window.agentOs.runtime.downloadUpdate()
    } finally {
      setBusy(false)
    }
  }, [busy, state.status])

  const handleInstall = useCallback(async () => {
    if (busy || state.status === 'installing') return
    setBusy(true)
    try {
      await window.agentOs.runtime.installUpdate({ quitAfterOpen: true })
    } catch {
      setBusy(false)
    }
  }, [busy, state.status])

  const handleRetry = useCallback(() => {
    // 错误后用户主动重试：实时拉取，绕过（可能缓存了失败结果的）节流。
    void window.agentOs.runtime.checkUpdate({ force: true })
  }, [])

  // idle / checking 态不展示。
  if (state.status === 'idle' || state.status === 'checking') return null

  const { status } = state
  const title =
    status === 'installing'
      ? t('settings.toast.installing')
      : status === 'downloaded'
        ? t('settings.toast.downloaded')
        : status === 'downloading'
          ? t('settings.toast.downloading')
          : status === 'available'
            ? t('settings.toast.foundNew')
            : status === 'error'
              ? t('settings.toast.updateFailed')
              : t('settings.toast.applyUpdate')

  return (
    <div
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 9999,
        width: 320,
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 14,
        boxShadow: 'var(--shadow-pop)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        <button
          onClick={onDismiss}
          aria-label={t('common.action.close')}
          style={{ ...btnBase, height: 22, width: 22, padding: 0, background: 'transparent', color: 'var(--text-muted)', fontSize: 14 }}
        >
          ✕
        </button>
      </div>

      {status === 'available' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>v{state.currentVersion}</span>
          <span style={{ color: 'var(--text-muted)' }}>→</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>v{state.latestVersion}</span>
        </div>
      )}

      {status === 'error' && (
        <div style={{ fontSize: 11.5, color: 'var(--danger)', lineHeight: 1.4 }}>{state.error || t('settings.toast.operationFailed')}</div>
      )}

      {status === 'downloading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-active)', overflow: 'hidden' }}>
            <div style={{ width: `${state.progress}%`, height: '100%', background: 'var(--accent)', transition: 'width .2s ease' }} />
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', minWidth: 32, textAlign: 'right' }}>
            {state.progress}%
          </span>
        </div>
      )}

      {status === 'downloaded' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{t('settings.toast.readyToInstall')}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        {status === 'available' && (
          <button
            onClick={handleDownload}
            disabled={busy}
            style={{ ...btnBase, background: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            {busy ? t('settings.toast.downloading') : t('settings.toast.downloadUpdate')}
          </button>
        )}
        {status === 'downloading' && (
          <button disabled style={{ ...btnBase, background: 'var(--bg-active)', color: 'var(--text-muted)', cursor: 'default' }}>
            {t('settings.toast.downloadingProgress', { progress: state.progress })}
          </button>
        )}
        {status === 'downloaded' && (
          <button
            onClick={handleInstall}
            disabled={busy}
            style={{ ...btnBase, background: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            {busy ? t('settings.toast.installing') : t('settings.toast.installUpdate')}
          </button>
        )}
        {status === 'error' && (
          <button
            onClick={handleRetry}
            style={{ ...btnBase, background: 'var(--bg-active)', color: 'var(--text-secondary)', border: '1px solid var(--border-medium)' }}
          >
            {t('settings.toast.recheck')}
          </button>
        )}
      </div>
    </div>
  )
}
