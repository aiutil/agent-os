// 新建 CLI 快速启动弹窗：选 CLI + 项目路径 → 立即打开终端会话。
// 由左二面板「新 CLI」触发，无需在内容区操作。

import { useEffect } from 'react'
import type { WorkbenchSessionView } from '@shared/types'
import { useSessionLaunch } from './useSessionLaunch'
import { ToolSelector } from '../../shared/ToolSelector'
import { BackendPicker } from '../../shared/BackendPicker'
import { WorkspaceSelector } from '../../shared/WorkspaceSelector'
import { ModelPicker } from '../../shared/ModelPicker'
import { useT } from '../../../lib/i18n'

export function CliLaunchDialog({
  onClose,
  onOpenSession
}: {
  onClose(): void
  onOpenSession(view: WorkbenchSessionView): void
}): React.JSX.Element {
  const { engineId, setEngineId, modelId, setModelId, reasoningEffort, setReasoningEffort, toolOptions, workspaceOptions, workspacePath, selectProject, pickFolder, launch, loading, runtimeHostId, backendSections, backendSelection, setBackend } =
    useSessionLaunch('cli')
  const { t } = useT()
  // 0 节点时 backendSections 仅一节「本机」→ 保留原 ToolSelector（逐字节不变）。
  const useUnified = backendSections.length > 1

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const start = async (): Promise<void> => {
    const created = await launch()
    if (created) {
      onOpenSession(created)
      onClose()
    }
  }

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(24,24,27,.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.action.openTerminal')}
        style={{
          width: 440,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-medium)',
          borderRadius: 14,
          boxShadow: '0 16px 48px rgba(24,24,27,.22)',
          padding: 20
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <svg width="15" height="15" viewBox="0 0 12 12" fill="none" style={{ color: 'var(--text-secondary)' }}>
            <rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M3.5 4.5l2 2-2 2M7 8.5h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{t('chat.action.openTerminal')}</div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          {t('chat.cliDialog.subtitle')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5 }}>{t('chat.cliDialog.cliTool')}</div>
            <div
              style={{
                display: 'flex',
                height: 36,
                alignItems: 'center',
                gap: 6,
                border: '1px solid var(--border-medium)',
                borderRadius: 9,
                padding: '0 4px',
                background: 'var(--bg-surface)'
              }}
            >
              {useUnified ? (
                <BackendPicker
                  sections={backendSections}
                  value={backendSelection}
                  onChange={setBackend}
                  placement="down"
                  size="md"
                />
              ) : (
                <ToolSelector value={engineId} onChange={setEngineId} tools={toolOptions} placement="down" />
              )}
              <ModelPicker
                toolId={engineId}
                hostId={runtimeHostId}
                hostRemote={runtimeHostId !== 'local'}
                value={modelId}
                onChange={setModelId}
                reasoningValue={reasoningEffort}
                onReasoningChange={setReasoningEffort}
                placement="down"
              />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5 }}>{t('chat.cliDialog.workdir')}</div>
            <div
              style={{
                display: 'flex',
                height: 36,
                alignItems: 'center',
                border: '1px solid var(--border-medium)',
                borderRadius: 9,
                padding: '0 8px',
                background: 'var(--bg-surface)'
              }}
            >
              <WorkspaceSelector
                value={workspacePath || null}
                onChange={(key) => selectProject(key)}
                workspaces={workspaceOptions}
                onAddProject={pickFolder}
                allowManualPath={runtimeHostId !== 'local'}
                addProjectLabel={
                  runtimeHostId !== 'local' ? t('channels.workspace.browseRemote') : undefined
                }
                keepOpenOnAddProject={runtimeHostId !== 'local'}
                showAddProject={runtimeHostId === 'local'}
              />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button
            onClick={onClose}
            style={{ height: 34, padding: '0 16px', borderRadius: 8, border: '1px solid var(--border-medium)', background: 'var(--bg-card)', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer', font: 'inherit' }}
          >
            {t('common.action.cancel')}
          </button>
          <button
            onClick={() => void start()}
            disabled={!engineId || loading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 34,
              padding: '0 18px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--text-primary)',
              color: 'var(--bg-surface)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              font: 'inherit',
              opacity: !engineId || loading ? 0.5 : 1
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="0.5" y="0.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.1" />
              <path d="M3.5 4l2 2-2 2M6.5 8h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t('chat.cliDialog.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
