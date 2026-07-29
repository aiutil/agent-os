// SPEC-033：聊天头来源徽标。读 view.runtimeHostId（联邦层已盖戳），
// 实时查 remoteNodeStatuses 取 label/在线态；本机或启动初查找 miss → 隐藏（诚实降级）。

import { useEffect, useState } from 'react'
import type { RemoteNodeStatus } from '@shared/types'
import { NodeIcon } from '../../lib/toolIcons'
import { useT } from '@renderer/lib/i18n'

export function OriginBadge({ hostId }: { hostId?: string }): React.JSX.Element | null {
  const { t } = useT()
  const [statuses, setStatuses] = useState<RemoteNodeStatus[]>([])

  useEffect(() => {
    void window.agentOs.runtime.remoteNodeStatuses().then(setStatuses).catch(() => {})
    const off = window.agentOs.events.onRemoteNodeStateChanged((s) =>
      setStatuses((prev) => {
        const next = prev.filter((p) => p.id !== s.id)
        next.push(s)
        return next
      })
    )
    return off
  }, [])

  if (!hostId || hostId === 'local') return null
  const node = statuses.find((s) => s.id === hostId)
  if (!node) return null
  const online = node.connection === 'connected'
  return (
    <span
      title={online ? t('web.origin.online', { label: node.label }) : t('web.origin.offline', { label: node.label })}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 18,
        padding: '0 7px',
        borderRadius: 9,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-panel)',
        color: 'var(--text-secondary)',
        fontSize: 10.5,
        fontWeight: 500,
        flexShrink: 0,
        maxWidth: 140,
        userSelect: 'none'
      }}
    >
      <NodeIcon size={10} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label}</span>
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: online ? 'var(--status-ok)' : 'var(--status-disconnect)',
          flexShrink: 0
        }}
      />
    </span>
  )
}
