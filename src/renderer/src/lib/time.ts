// 时间展示与分组工具：相对时间、按月分组。统一此前散落在多个文件的 relativeTime 实现。
// 相对文案走 i18n（workbench.time.*），日期走 localeFor；非组件 .ts 默认读渲染端当前语言。

import { t, localeFor } from '@shared/i18n'
import type { Lang } from '@shared/i18n'
import { getCurrentRendererLang } from './i18n'

/**
 * 相对时间。zh：刚刚 / N分钟前 / N小时前 / N天前；en：just now / N min ago / N h ago / N d ago。
 * 超过 30 天回退为本地化日期。组件调用可传 useT() 的 lang 以随语言切换重渲染。
 */
export function relativeTime(iso: string, lang?: Lang): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const resolvedLang = lang ?? getCurrentRendererLang()
  const min = Math.floor((Date.now() - then) / 60000)
  if (min < 1) return t(resolvedLang, 'workbench.time.justNow')
  if (min < 60) return t(resolvedLang, 'workbench.time.minutesAgo', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t(resolvedLang, 'workbench.time.hoursAgo', { count: hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t(resolvedLang, 'workbench.time.daysAgo', { count: day })
  return new Date(iso).toLocaleDateString(localeFor(resolvedLang))
}

export interface MonthGroup<T> {
  /** 'YYYY-MM' */
  key: string
  /** zh 'YYYY年M月'；en 'Month YYYY' */
  label: string
  items: T[]
}

function monthLabel(date: Date, lang: Lang): string {
  if (lang === 'zh') return `${date.getFullYear()}年${date.getMonth() + 1}月`
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long' }).format(date)
}

/**
 * 按 createdAt 的年月分组：组按月份倒序（最近在上），组内按 createdAt 倒序。
 * 用于「每月记忆了什么」的时间轴展示。无 createdAt 或非法时间的数据被丢弃。
 */
export function groupByMonth<T extends { createdAt: string }>(items: T[], lang?: Lang): MonthGroup<T>[] {
  const resolvedLang = lang ?? getCurrentRendererLang()
  const map = new Map<string, MonthGroup<T>>()
  for (const item of items) {
    const date = new Date(item.createdAt)
    if (Number.isNaN(date.getTime())) continue
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    let group = map.get(key)
    if (!group) {
      group = { key, label: monthLabel(date, resolvedLang), items: [] }
      map.set(key, group)
    }
    group.items.push(item)
  }
  const groups = [...map.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  for (const group of groups) {
    group.items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }
  return groups
}
