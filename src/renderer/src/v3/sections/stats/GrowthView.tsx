// 成长镜头：Cardex 卡牌图鉴。装载 growth + 全期 activity 数据，并按 gamification 开关门控。
// 数据来自 stats.growth() / stats.activity({ range: 'all' })，索引完成后自动刷新。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatsActivity, StatsGrowth, StatsQuery } from '@shared/types'
import { useT } from '../../../lib/i18n'
import { CardexPanel } from './CardexPanel'

// 卡牌指标是终身累计值，固定取全期数据，不随统计页的时间筛选变化。
const ALL_TIME: StatsQuery = { range: 'all' }

const surfaceCenter: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexDirection: 'column',
  gap: 14,
  background: 'var(--bg-surface)',
  color: 'var(--text-muted)'
}

function GrowthIcon(): React.JSX.Element {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
      <path d="M5 36L14 22l9 7 9-14 7 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="5" cy="36" r="2" fill="currentColor" />
      <circle cx="39" cy="18" r="2" fill="currentColor" />
    </svg>
  )
}

export function GrowthView(): React.JSX.Element {
  const { t } = useT()
  const [growth, setGrowth] = useState<StatsGrowth | null>(null)
  const [activity, setActivity] = useState<StatsActivity | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshTimerRef = useRef<number | null>(null)

  const loadData = useCallback(async () => {
    const [g, a] = await Promise.all([
      window.agentOs.stats.growth(),
      window.agentOs.stats.activity(ALL_TIME)
    ])
    setGrowth(g)
    setActivity(a)
  }, [])

  const load = useCallback(async () => {
    const on = await window.agentOs.stats.getGamificationEnabled().catch(() => true)
    setEnabled(on)
    if (on) await loadData().catch(() => {})
    setLoading(false)
  }, [loadData])

  useEffect(() => {
    void load()
  }, [load])

  // 索引完成后防抖刷新（与统计页一致）
  useEffect(() => {
    if (!enabled) return
    const unsubscribe = window.agentOs.events.onMemoryIndexProgress((status) => {
      if (status.building) return
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = window.setTimeout(() => {
        void loadData()
      }, 700)
    })
    return () => {
      unsubscribe()
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
    }
  }, [enabled, loadData])

  const enableGrowth = useCallback(async () => {
    await window.agentOs.stats.setGamificationEnabled(true).catch(() => {})
    setLoading(true)
    await load()
  }, [load])

  if (enabled === false) {
    return (
      <div style={surfaceCenter}>
        <GrowthIcon />
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-secondary)' }}>{t('stats.growthView.disabledTitle')}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 260, lineHeight: 1.55 }}>
          {t('stats.growthView.disabledCopy1')}
          <br />
          {t('stats.growthView.disabledCopy2')}
        </div>
        <button
          onClick={() => void enableGrowth()}
          style={{
            marginTop: 4,
            padding: '7px 16px',
            borderRadius: 8,
            border: 'none',
            background: 'var(--accent)',
            color: 'var(--accent-fg)',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            font: 'inherit'
          }}
        >
          {t('stats.growthView.enable')}
        </button>
      </div>
    )
  }

  if (loading || !growth || !activity) {
    return (
      <div style={surfaceCenter}>
        <div style={{ fontSize: 13 }}>{t('stats.growthView.loading')}</div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-surface)' }}>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0 22px', scrollbarWidth: 'thin' }}>
        <CardexPanel growth={growth} activity={activity} />
      </div>
    </div>
  )
}
