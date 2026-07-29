// 成长统计计算 — 直接参考 agent-life 的 XP 曲线、等级标题、维度评分。
// 参考: agent-life/electron/statistics.cjs

import type { StatsGrowth, DimensionScore } from '@shared/types'
import { tr } from '@shared/i18n'

export interface GrowthInput {
  activeDays: number
  sessions: number
  prompts: number
  favoriteTool: string | null
  peakHour: number | null
  /** 近 7 天活跃天数（用于 Consistency 维度），无则回退 activeDays/14 */
  weeklyActiveDays?: number
  /** 连续活跃周数 */
  streakWeeks?: number
  /** 已配置/使用过的 CLI 工具数（Breadth/Creativity 维度） */
  agentDiversity?: number
  /** 记忆条数 */
  memoriesCount?: number
}

// ─── XP 曲线（agent-life: xpForLevel = round(level^2.18 * 18)） ─────────────

function xpForLevel(level: number): number {
  return Math.round(Math.pow(level, 2.18) * 18)
}

function levelFromXp(xp: number): number {
  const level = Math.floor(Math.pow(xp / 18, 1 / 2.18))
  return Math.max(1, Math.min(100, level))
}

// ─── 等级标题（agent-life LEVEL_TITLES） ────────────────────────────────────
// 标题文案走 i18n（stats.growth.levelTitle），调用时按当前语言解析。

function titleForLevel(level: number): string {
  const titles: Array<{ min: number; title: string }> = [
    { min: 1, title: tr('stats.growth.levelTitle.novice') },
    { min: 5, title: tr('stats.growth.levelTitle.apprentice') },
    { min: 12, title: tr('stats.growth.levelTitle.operator') },
    { min: 24, title: tr('stats.growth.levelTitle.artisan') },
    { min: 38, title: tr('stats.growth.levelTitle.architect') },
    { min: 55, title: tr('stats.growth.levelTitle.whisperer') },
    { min: 75, title: tr('stats.growth.levelTitle.master') },
    { min: 100, title: tr('stats.growth.levelTitle.transcendent') }
  ]
  return [...titles].reverse().find((item) => level >= item.min)?.title ?? titles[0].title
}

// ─── 维度定义（agent-life DIMENSION_DEFS） ──────────────────────────────────

function clamp10(value: number): number {
  return Math.max(0, Math.min(10, Math.round(value)))
}

interface DimensionDef {
  key: string
  compute(ctx: DimensionContext): number
}

interface DimensionContext {
  skillsCount: number
  memoriesCount: number
  sessions: number
  cliInteractions: number
  weeklyActiveDays: number
  streakWeeks: number
  agentDiversity: number
}

const DIMENSION_DEFS: DimensionDef[] = [
  {
    key: 'creativity',
    compute: (ctx) => clamp10(ctx.skillsCount / 3 + ctx.memoriesCount / 20)
  },
  {
    key: 'efficiency',
    compute: (ctx) => clamp10(ctx.sessions / 10 + ctx.cliInteractions / 20)
  },
  {
    key: 'consistency',
    compute: (ctx) => clamp10((ctx.weeklyActiveDays / 7) * 5 + ctx.streakWeeks * 0.5)
  },
  {
    key: 'depth',
    compute: (ctx) => clamp10(ctx.sessions / 15 + ctx.memoriesCount / 30)
  },
  {
    key: 'breadth',
    compute: (ctx) => clamp10((ctx.agentDiversity / 4) * 6 + ctx.skillsCount / 5)
  }
]

function dimensionLabel(key: string): string {
  switch (key) {
    case 'creativity': return tr('stats.growth.dimension.creativity')
    case 'efficiency': return tr('stats.growth.dimension.efficiency')
    case 'consistency': return tr('stats.growth.dimension.consistency')
    case 'depth': return tr('stats.growth.dimension.depth')
    case 'breadth': return tr('stats.growth.dimension.breadth')
    default: return key
  }
}

function dimensionInsight(key: string, value: number): string {
  if (value >= 8) {
    switch (key) {
      case 'creativity': return tr('stats.growth.dimInsight.high.creativity')
      case 'efficiency': return tr('stats.growth.dimInsight.high.efficiency')
      case 'consistency': return tr('stats.growth.dimInsight.high.consistency')
      case 'depth': return tr('stats.growth.dimInsight.high.depth')
      case 'breadth': return tr('stats.growth.dimInsight.high.breadth')
      default: return tr('stats.growth.dimInsight.highDefault')
    }
  }
  if (value >= 5) {
    return tr('stats.growth.dimInsight.mid', { value })
  }
  return tr('stats.growth.dimInsight.low', { value })
}

export function calculateGrowth(input: GrowthInput): StatsGrowth {
  // ── 基础计数 ──
  const sessions = input.sessions
  const cliInteractions = input.prompts
  const memoriesCount = input.memoriesCount ?? 0
  // skillsCount 暂按真实使用过的 CLI 数映射为成长权重，不读取“已安装但未使用”的工具。
  const skillsCount = (input.agentDiversity ?? 1) * 3
  const agentDiversity = input.agentDiversity ?? 1
  const streakWeeks = input.streakWeeks ?? Math.floor(input.activeDays / 7)
  const weeklyActiveDays = input.weeklyActiveDays ?? Math.min(7, Math.ceil(input.activeDays / 14))

  // ── XP 计算（agent-life 公式） ──
  const xp =
    cliInteractions * 3 +
    sessions * 28 +
    memoriesCount * 2 +
    skillsCount * 6 +
    agentDiversity * 60 +
    streakWeeks * 10

  const aiLevel = levelFromXp(xp)
  const currentLevelXp = xpForLevel(aiLevel)
  const nextLevelXp = aiLevel >= 100 ? currentLevelXp : xpForLevel(aiLevel + 1)
  const progressPct =
    aiLevel >= 100
      ? 100
      : Math.round(((xp - currentLevelXp) / Math.max(1, nextLevelXp - currentLevelXp)) * 100)

  // ── 维度评分 ──
  const dimCtx: DimensionContext = {
    skillsCount,
    memoriesCount,
    sessions,
    cliInteractions,
    weeklyActiveDays,
    streakWeeks,
    agentDiversity
  }
  const dimensions: DimensionScore[] = DIMENSION_DEFS.map((def) => {
    const value = def.compute(dimCtx)
    return {
      key: def.key,
      label: dimensionLabel(def.key),
      value,
      insight: dimensionInsight(def.key, value)
    }
  })

  // ── 成就（兼容旧结构） ──
  const achievements = [
    {
      id: 'active-week',
      title: tr('stats.growth.achievement.activeWeek.title'),
      description: tr('stats.growth.achievement.activeWeek.desc'),
      unlocked: input.activeDays >= 7
    },
    {
      id: 'ten-sessions',
      title: tr('stats.growth.achievement.tenSessions.title'),
      description: tr('stats.growth.achievement.tenSessions.desc'),
      unlocked: input.sessions >= 10
    },
    {
      id: 'fifty-prompts',
      title: tr('stats.growth.achievement.fiftyPrompts.title'),
      description: tr('stats.growth.achievement.fiftyPrompts.desc'),
      unlocked: input.prompts >= 50
    },
    {
      id: 'level-12',
      title: tr('stats.growth.achievement.level12.title'),
      description: tr('stats.growth.achievement.level12.desc'),
      unlocked: aiLevel >= 12
    },
    {
      id: 'level-24',
      title: tr('stats.growth.achievement.level24.title'),
      description: tr('stats.growth.achievement.level24.desc'),
      unlocked: aiLevel >= 24
    }
  ]

  // ── 洞察 ──
  const insights: string[] = []
  if (input.favoriteTool) insights.push(tr('stats.growth.insight.favoriteTool', { tool: input.favoriteTool }))
  if (input.peakHour !== null) {
    if (input.peakHour >= 22 || input.peakHour < 5) {
      insights.push(tr('stats.growth.insight.deepNight'))
    } else if (input.peakHour < 12) {
      insights.push(tr('stats.growth.insight.morning'))
    } else if (input.peakHour < 18) {
      insights.push(tr('stats.growth.insight.afternoon'))
    } else {
      insights.push(tr('stats.growth.insight.evening'))
    }
  }
  // 取最高维度作为洞察
  const topDim = [...dimensions].sort((a, b) => b.value - a.value)[0]
  if (topDim && topDim.value >= 5) {
    insights.push(tr('stats.growth.insight.topDim', { label: topDim.label, value: topDim.value }))
  }

  return {
    level: aiLevel,
    levelTitle: titleForLevel(aiLevel),
    progressPct: Math.max(0, Math.min(100, progressPct)),
    nextLevelHint: aiLevel >= 100
      ? tr('stats.growth.nextLevelHint.max')
      : tr('stats.growth.nextLevelHint.next', { level: aiLevel + 1, xp: nextLevelXp }),
    xp,
    currentLevelXp,
    nextLevelXp,
    dimensions,
    achievements,
    insights,
    cliInteractions,
    sessionCount: sessions,
    memoriesCount,
    streakWeeks
  }
}
