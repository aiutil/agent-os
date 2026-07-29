// 统计镜头二级面板（统计 / 成长 导航）。复刻原型 StatsPanel。

import { useT } from '../../../lib/i18n'

const IcStats = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 12.5L5.5 8 8.5 10.5 12 5.5 14 7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function StatsSecPanel({
  activeStats,
  onNavStats
}: {
  activeStats: 'stats' | 'growth'
  onNavStats(v: 'stats' | 'growth'): void
}): React.JSX.Element {
  const { t } = useT()
  const items = [
    { k: 'stats', l: t('stats.secPanel.stats') },
    { k: 'growth', l: t('stats.secPanel.growth') }
  ] as const
  return (
    <>
      <div className="panel-divider" style={{ margin: '7px 7px 2px' }} />
      <div className="sec-scroll">
        {items.map((it) => (
          <button
            key={it.k}
            className={`session-item ${activeStats === it.k ? 'is-active' : ''}`}
            style={{ width: '100%' }}
            onClick={() => onNavStats(it.k)}
          >
            <IcStats />
            <span style={{ fontSize: 11.5, fontWeight: 500 }}>{it.l}</span>
          </button>
        ))}
      </div>
    </>
  )
}
