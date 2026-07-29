// 会话镜头底部活动热力（接 stats.activity）。
// 取最近 26 周 × 7 天，按真实每日 prompt 数映射热度等级。

import { useEffect, useState } from 'react'
import type { StatsActivity } from '@shared/types'
import { localeFor } from '@shared/i18n'
import { useT } from '../../../lib/i18n'
import { heatLevel } from '../../../lib/heatmap'

interface Cell {
  level: number
  empty: boolean
}

function buildGrid(days: Map<string, number>): { cells: Cell[]; cols: number } {
  const WEEKS = 26
  const tail = WEEKS * 7
  const today = new Date()
  const cells: Cell[] = []
  for (let i = tail - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    cells.push({ level: heatLevel(days.get(d.toISOString().slice(0, 10)) ?? 0), empty: false })
  }
  const firstDay = new Date(today)
  firstDay.setDate(today.getDate() - (tail - 1))
  for (let i = 0; i < firstDay.getDay(); i++) cells.unshift({ level: 0, empty: true })
  for (let i = 0; i < 6 - today.getDay(); i++) cells.push({ level: 0, empty: true })
  return { cells, cols: Math.ceil(cells.length / 7) }
}

export function ActivityHeat(): React.JSX.Element {
  const { t, lang } = useT()
  const [activity, setActivity] = useState<StatsActivity | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.agentOs.stats
      .activity({ range: 'all' })
      .then((next) => {
        if (!cancelled) setActivity(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 始终渲染网格（加载/失败时为空网格），保证该区域可见且固定在面板底部。
  const dayMap = new Map((activity?.days ?? []).map((d) => [d.date, d.prompts]))
  const { cells, cols } = buildGrid(dayMap)
  const total = activity?.totalPrompts ?? 0
  const streak = activity?.currentStreak ?? 0

  return (
    <div className="sec-bottom">
      <div className="heat-grid" style={{ aspectRatio: `${cols}/7` }}>
        {cells.map((c, i) => (
          <span key={i} className={`heat-cell ${c.empty ? 'e' : 'l' + c.level}`} />
        ))}
      </div>
      <div className="sec-stat">
        {t('stats.activity.interactions', { count: new Intl.NumberFormat(localeFor(lang)).format(total) })}
        {streak > 0 ? ` · ${t('stats.activity.streak', { count: streak })}` : ''}
      </div>
    </div>
  )
}
