// CLI 工具选择器（精确复刻 V3 原型 ToolSelector），数据接真实扫描结果。
// 下拉用 PortalMenu 渲染，避免在对比面板等 overflow:hidden 容器中被裁切。

import { useRef, useState } from 'react'
import { ToolIcon } from '../../lib/toolIcons'
import { useT } from '../../lib/i18n'
import { PortalMenu } from './PortalMenu'

export interface ToolOption {
  key: string
  label: string
  sub: string
  color: string
}

export function ToolSelector({
  value,
  onChange,
  tools,
  placement = 'up'
}: {
  value: string
  onChange(key: string): void
  tools: ToolOption[]
  placement?: 'up' | 'down'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const { t } = useT()
  const tool = tools.find((tl) => tl.key === value) ?? tools[0]

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 10px',
          height: 28,
          borderRadius: 7,
          border: 'none',
          background: open ? 'var(--bg-active)' : 'transparent',
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          transition: 'background 160ms',
          font: 'inherit'
        }}
      >
        {tool ? <ToolIcon toolId={tool.key} size={16} brandColor /> : <span>{t('channels.tool.selectCli')}</span>}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          style={{ opacity: 0.5, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }}
        >
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <PortalMenu anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={220} placement={placement} align="left">
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            padding: '5px 10px 3px'
          }}
        >
          {t('channels.tool.selectTool')}
        </div>
        {tools.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: 11.5, color: 'var(--text-muted)' }}>{t('channels.tool.noCli')}</div>
        )}
        {tools.map((tl) => {
          const active = tl.key === value
          return (
            <button
              key={tl.key}
              onClick={() => {
                onChange(tl.key)
                setOpen(false)
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 10px',
                borderRadius: 7,
                border: 'none',
                background: active ? 'var(--bg-active)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit'
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: 'var(--bg-panel)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}
              >
                <ToolIcon toolId={tl.key} size={15} brandColor />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: active ? 600 : 500, color: 'var(--text-primary)' }}>{tl.label}</div>
                {tl.sub && (
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1, fontFamily: 'var(--font-mono)' }}>{tl.sub}</div>
                )}
              </div>
              {active && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="var(--text-primary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          )
        })}
      </PortalMenu>
    </>
  )
}
