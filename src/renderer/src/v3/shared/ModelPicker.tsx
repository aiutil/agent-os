// SPEC-041：只展示 Agent 原生目录；目录不可用时保留 CLI 默认与自定义模型 ID。
// 思考级别来自模型元数据或 CLI 原生帮助，不在渲染层硬编码。

import { useEffect, useRef, useState } from 'react'
import type {
  ReasoningEffortOption,
  ToolModelCatalog,
  ToolModelInfo
} from '@shared/types'
import { useT } from '../../lib/i18n'
import { PortalMenu } from './PortalMenu'

const EMPTY_CATALOG: ToolModelCatalog = {
  models: [],
  source: 'unavailable',
  supportsCustomModel: true
}

export function ModelPicker({
  toolId,
  hostId,
  hostRemote = false,
  value,
  onChange,
  onModelInfoChange,
  reasoningValue,
  onReasoningChange,
  placement = 'up'
}: {
  toolId: string
  hostId?: string
  hostRemote?: boolean
  value: string
  onChange(v: string): void
  onModelInfoChange?(model: ToolModelInfo | undefined): void
  reasoningValue?: string
  onReasoningChange?(v: string): void
  placement?: 'up' | 'down'
}): React.JSX.Element | null {
  const [catalog, setCatalog] = useState<ToolModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [customModel, setCustomModel] = useState('')
  const { t } = useT()
  const anchorRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!toolId) {
      setCatalog(EMPTY_CATALOG)
      return
    }
    let cancelled = false
    setLoading(true)
    setCatalog(null)
    const fetcher = hostRemote
      ? window.agentOs.discovery.listModelsOn({ toolId, hostId })
      : window.agentOs.discovery.listModels(toolId)
    void fetcher
      .then((next) => {
        if (!cancelled) setCatalog(next)
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog({
            ...EMPTY_CATALOG,
            supportsCustomModel: !hostRemote
          })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [toolId, hostId, hostRemote])

  useEffect(() => {
    if (!open) return
    setCustomModel(value)
  }, [open, value])

  const selected = catalog?.models.find((model) => model.id === value)
  const defaultModel = catalog?.models.find((model) => model.isDefault)
  const reasoningOptions =
    selected?.reasoningEfforts ??
    (!value ? defaultModel?.reasoningEfforts : undefined) ??
    catalog?.reasoningEfforts ??
    []
  const reasoningIds = reasoningOptions.map((option) => option.id).join('\u0000')

  useEffect(() => {
    onModelInfoChange?.(selected ?? (!value ? defaultModel : undefined))
  }, [selected, defaultModel, value, onModelInfoChange])

  useEffect(() => {
    if (
      reasoningValue &&
      onReasoningChange &&
      !reasoningOptions.some((option) => option.id === reasoningValue)
    ) {
      onReasoningChange('')
    }
  }, [reasoningValue, reasoningIds, onReasoningChange])

  if (!toolId || toolId === 'shell') return null

  if (catalog === null) {
    return (
      <span className="dir-pill" aria-busy={loading}>
        {loading ? t('channels.model.loading') : t('common.label.model')}
      </span>
    )
  }

  if (hostRemote && catalog.models.length === 0 && !catalog.supportsCustomModel) {
    return (
      <span
        className="dir-pill"
        aria-disabled="true"
        title={t('channels.model.remoteUnsupportedTitle')}
        style={{ cursor: 'not-allowed', color: 'var(--text-muted)' }}
      >
        {t('channels.model.remoteDecided')}
      </span>
    )
  }

  const triggerLabel = selected?.label ?? (value || t('channels.model.defaultCliDecide'))

  const chooseModel = (model: string): void => {
    onChange(model)
    onReasoningChange?.('')
    setOpen(false)
  }

  return (
    <>
      <button
        ref={anchorRef}
        className="dir-pill model-picker__trigger"
        onClick={() => setOpen((current) => !current)}
        title={triggerLabel}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          maxWidth: 180,
          flexShrink: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden'
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{triggerLabel}</span>
        <Chevron />
      </button>
      <PortalMenu
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        width={340}
        placement={placement}
        align="left"
      >
        <div style={{ maxHeight: 310, overflowY: 'auto' }}>
          <ModelRow
            label={t('channels.model.defaultCliDecide')}
            sub=""
            active={value === ''}
            onClick={() => chooseModel('')}
          />
          {catalog.models.map((model) => (
            <ModelRow
              key={model.id}
              label={model.label}
              sub={model.provider ?? ''}
              active={model.id === value}
              onClick={() => chooseModel(model.id)}
            />
          ))}
          {catalog.supportsCustomModel && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const next = customModel.trim()
                if (next) chooseModel(next)
              }}
              style={{
                display: 'flex',
                gap: 6,
                padding: '8px 10px',
                borderTop: '1px solid var(--border-subtle)'
              }}
            >
              <input
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
                placeholder={t('channels.model.customPlaceholder')}
                aria-label={t('channels.model.customPlaceholder')}
                style={{
                  minWidth: 0,
                  flex: 1,
                  height: 28,
                  borderRadius: 6,
                  border: '1px solid var(--border-medium)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-primary)',
                  padding: '0 8px',
                  fontFamily: 'inherit',
                  fontSize: 12
                }}
              />
              <button
                type="submit"
                disabled={!customModel.trim()}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: '1px solid var(--border-medium)',
                  background: 'var(--bg-active)',
                  color: 'var(--text-primary)',
                  padding: '0 9px',
                  fontFamily: 'inherit',
                  cursor: customModel.trim() ? 'pointer' : 'not-allowed'
                }}
              >
                {t('channels.model.useCustom')}
              </button>
            </form>
          )}
          {catalog.source === 'unavailable' && (
            <div
              title={catalog.error}
              style={{ padding: '3px 10px 8px', color: 'var(--text-muted)', fontSize: 11 }}
            >
              {t('channels.model.catalogUnavailable')}
            </div>
          )}
        </div>
      </PortalMenu>
      {onReasoningChange && reasoningOptions.length > 0 && (
        <ReasoningPicker
          options={reasoningOptions}
          value={reasoningValue ?? ''}
          onChange={onReasoningChange}
          placement={placement}
        />
      )}
    </>
  )
}

function ReasoningPicker({
  options,
  value,
  onChange,
  placement
}: {
  options: ReasoningEffortOption[]
  value: string
  onChange(value: string): void
  placement: 'up' | 'down'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const { t } = useT()
  const selected = options.find((option) => option.id === value)
  const triggerLabel = selected?.label ?? t('channels.model.reasoningDefault')

  return (
    <>
      <button
        ref={anchorRef}
        className="dir-pill"
        onClick={() => setOpen((current) => !current)}
        title={t('channels.model.reasoningTitle')}
        style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
      >
        <span>{triggerLabel}</span>
        <Chevron />
      </button>
      <PortalMenu
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        width={220}
        placement={placement}
        align="left"
      >
        <ModelRow
          label={t('channels.model.reasoningDefault')}
          sub=""
          active={!value}
          onClick={() => {
            onChange('')
            setOpen(false)
          }}
        />
        {options.map((option) => (
          <ModelRow
            key={option.id}
            label={option.label}
            sub={option.isDefault ? t('common.label.default') : ''}
            active={value === option.id}
            onClick={() => {
              onChange(option.id)
              setOpen(false)
            }}
          />
        ))}
      </PortalMenu>
    </>
  )
}

function Chevron(): React.JSX.Element {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{ opacity: 0.5 }}>
      <path
        d="M1 2.5L4 5.5L7 2.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ModelRow({
  label,
  sub,
  active,
  onClick
}: {
  label: string
  sub: string
  active: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        borderRadius: 7,
        border: 'none',
        background: active ? 'var(--bg-active)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: active ? 600 : 400
      }}
    >
      <span
        style={{
          minWidth: 0,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {label}
      </span>
      {sub && (
        <span
          title={sub}
          style={{
            maxWidth: 128,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-muted)'
          }}
        >
          {sub}
        </span>
      )}
    </button>
  )
}
