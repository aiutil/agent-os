// 接力触发器：从某个来源会话（chat / cli / history）一键接力给其他 Agent。
// 在会话镜头 header 与「存储 → 会话记录」详情页复用同一份菜单与采集逻辑（SPEC-017 §5）。
// 按钮形态可参数化：会话镜头里显示当前 Agent（切换器语义），记录详情页显示「接力给」。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RelayTarget, RemoteNodeStatus, WorkbenchSessionView } from '@shared/types'
import { useSessionsStore } from '../../stores/sessionsStore'
import { ToolIcon } from '../../lib/toolIcons'
import { PortalMenu } from './PortalMenu'
import { ModelPicker } from './ModelPicker'
import { useT } from '../../lib/i18n'

const TRIGGER_ICON_SIZE = 20

export interface RelayTriggerProps {
  /** 来源会话 ID：chat/cli 镜头传活跃会话 id；history 传 transcript id（toolId:nativeSessionId）。 */
  sourceSessionId: string
  sourceSurface: 'chat' | 'cli' | 'history'
  /** 来源 Agent，用于按钮图标与菜单「当前」展示。 */
  sourceToolId: string
  /** 来源 Agent 显示名，用于按钮文字与菜单「当前」展示。 */
  sourceDisplayName: string
  /** 来源运行节点（本机/远程），用于菜单「当前」展示。 */
  sourceRuntimeHostId?: string
  /** 覆盖按钮文字（默认 sourceDisplayName）。记录详情页传「接力给」。 */
  triggerLabel?: string
  /** 隐藏按钮上的来源 Agent 图标（记录详情页 header 已有图标时使用）。 */
  hideIcon?: boolean
  /** 浮层对齐，默认按来源 surface 推导：cli 右对齐，其余左对齐。 */
  menuAlign?: 'left' | 'right'
  /** 接力成功后回调（通常用于跳转到新会话标签）。 */
  onRelayed?: (view: WorkbenchSessionView) => void
}

export function RelayTrigger({
  sourceSessionId,
  sourceSurface,
  sourceToolId,
  sourceDisplayName,
  sourceRuntimeHostId,
  triggerLabel,
  hideIcon,
  menuAlign,
  onRelayed
}: RelayTriggerProps): React.JSX.Element {
  const { t } = useT()
  const relay = useSessionsStore((s) => s.relay)
  const setNotice = useSessionsStore((s) => s.setNotice)
  const [remoteStatuses, setRemoteStatuses] = useState<RemoteNodeStatus[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [targets, setTargets] = useState<RelayTarget[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [modelId, setModelId] = useState('')
  const btnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    void window.agentOs.runtime.remoteNodeStatuses().then(setRemoteStatuses).catch(() => {})
    return window.agentOs.events.onRemoteNodeStateChanged((status) =>
      setRemoteStatuses((prev) => {
        const next = prev.filter((item) => item.id !== status.id)
        next.push(status)
        return next
      })
    )
  }, [])

  const targetKey = (target: RelayTarget): string => `${target.runtimeHostId ?? 'local'}/${target.toolId}`
  const selectedTarget = targets.find((target) => targetKey(target) === selectedKey) ?? null
  const hostLabel = (hostId?: string): string => {
    if (!hostId || hostId === 'local') return t('tasks.local')
    return remoteStatuses.find((status) => status.id === hostId)?.label ?? hostId
  }
  const groupedTargets = useMemo(() => {
    const groups = new Map<string, RelayTarget[]>()
    for (const target of targets) {
      const hostId = target.runtimeHostId ?? 'local'
      groups.set(hostId, [...(groups.get(hostId) ?? []), target])
    }
    return [...groups.entries()].sort(([a], [b]) => (a === 'local' ? -1 : b === 'local' ? 1 : a.localeCompare(b)))
  }, [targets])

  const align = menuAlign ?? (sourceSurface === 'cli' ? 'right' : 'left')

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (!next || targets.length > 0 || loading) return
    setLoading(true)
    void window.agentOs.relay
      .listTargets(sourceSessionId)
      .then((list) => {
        setTargets(list)
        const first = list.find((target) => target.availability === 'available')
        if (first) setSelectedKey(targetKey(first))
      })
      .finally(() => setLoading(false))
  }

  const choose = (target: RelayTarget): void => {
    setSelectedKey(targetKey(target))
    setModelId('')
  }

  const startRelay = async (): Promise<void> => {
    const target = selectedTarget
    if (!target) return
    if (target.availability !== 'available') {
      setNotice(t('workbench.relay.unavailableNotice', {
        name: target.displayName,
        reason: target.reason ?? t('workbench.relay.checkCli')
      }), 'warning')
      await window.agentOs.relay.openRepair(target.toolId).catch(() => undefined)
      return
    }
    setOpen(false)
    const created = await relay(
      {
        sourceSessionId,
        sourceSurface,
        targetToolId: target.toolId,
        ...(target.runtimeHostId ? { targetRuntimeHostId: target.runtimeHostId } : {}),
        ...(modelId ? { targetModel: modelId } : {})
      },
      target.displayName
    )
    if (created) onRelayed?.(created)
  }

  const label = triggerLabel ?? sourceDisplayName

  return (
    <div className="relay-trigger">
      <button ref={btnRef} className="relay-trigger__button" onClick={toggle}>
        {!hideIcon && <ToolIcon toolId={sourceToolId} size={TRIGGER_ICON_SIZE} brandColor />}
        <span>{label}</span>
        <span className="relay-trigger__chev">▾</span>
      </button>
      <PortalMenu
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        width={276}
        placement="down"
        align={align}
        animateEnter
      >
        <div className="relay-trigger__menu-panel">
          <div className="relay-trigger__title">{t('workbench.relay.to')}</div>
          <div className="relay-trigger__current">{t('workbench.relay.current', { value: `${hostLabel(sourceRuntimeHostId)} / ${sourceDisplayName}` })}</div>
          {loading ? (
            <div className="relay-trigger__empty">{t('workbench.relay.loading')}</div>
          ) : targets.length === 0 ? (
            <div className="relay-trigger__empty">{t('workbench.relay.empty')}</div>
          ) : (
            <>
              <div className="relay-trigger__list">
                {groupedTargets.map(([hostId, list]) => (
                  <div key={hostId}>
                    <div className="relay-trigger__section">
                      <span>{hostLabel(hostId)}</span>
                      <i />
                    </div>
                    {list.map((target) => {
                      const key = targetKey(target)
                      const active = key === selectedKey
                      return (
                        <button
                          key={key}
                          className={`relay-trigger__item ${target.availability !== 'available' ? 'is-disabled' : ''} ${active ? 'is-active' : ''}`}
                          onClick={() => choose(target)}
                        >
                          <ToolIcon toolId={target.toolId} size={15} brandColor />
                          <span>
                            <strong>{target.displayName}</strong>
                            <small>{target.version ? `v${target.version}` : target.toolId}</small>
                          </span>
                          <em>{target.availability === 'available' ? t('workbench.relay.available') : target.reason ?? t('workbench.relay.unavailable')}</em>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
              {selectedTarget && (
                <div className="relay-trigger__footer">
                  <div className="relay-trigger__model">
                    <span>{t('workbench.relay.model')}</span>
                    <ModelPicker
                      toolId={selectedTarget.toolId}
                      hostId={selectedTarget.runtimeHostId}
                      hostRemote={Boolean(selectedTarget.runtimeHostId && selectedTarget.runtimeHostId !== 'local')}
                      value={modelId}
                      onChange={setModelId}
                      placement="down"
                    />
                  </div>
                  <button
                    className="relay-trigger__start"
                    disabled={selectedTarget.availability !== 'available'}
                    onClick={() => void startRelay()}
                  >
                    {t('workbench.relay.start')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </PortalMenu>
    </div>
  )
}
