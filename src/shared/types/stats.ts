export type StatsRange = '7d' | '30d' | '90d' | 'all'

export const UNASSIGNED_STATS_PROJECT_KEY = '__agent_os_unassigned_project__'

export interface StatsQuery {
  range: StatsRange
  toolIds?: string[]
  workspacePath?: string
  unassignedWorkspace?: boolean
}

export interface UsageTokens {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface TranscriptUsageFact {
  key: string
  model: string | null
  timestamp: string | null
  tokens: UsageTokens
}

export interface StatsBreakdownItem {
  key: string
  label: string
  sessions: number
  prompts: number
  tokens: number
  estimatedCostUsd: number | null
  hasUnpricedUsage: boolean
}

export interface StatsTrendPoint {
  date: string
  prompts: number
  tokens: number
  estimatedCostUsd: number | null
}

export interface StatsModelBreakdownItem {
  key: string
  label: string
  sessions: number
  facts: number
  tokens: UsageTokens & { total: number }
  estimatedCostUsd: number | null
  hasUnpricedUsage: boolean
}

export interface StatsModelTrendPoint {
  date: string
  model: string
  tokens: number
}

export interface StatsSummary {
  sessions: number
  prompts: number
  tokens: UsageTokens & { total: number }
  estimatedCostUsd: number | null
  hasUnpricedUsage: boolean
  byTool: StatsBreakdownItem[]
  byModel: StatsModelBreakdownItem[]
  byProject: StatsBreakdownItem[]
  modelTrend: StatsModelTrendPoint[]
  trend: StatsTrendPoint[]
}

export type StatsDashboardSummary = Pick<
  StatsSummary,
  'sessions' | 'prompts' | 'tokens' | 'estimatedCostUsd' | 'hasUnpricedUsage' | 'byTool' | 'byProject'
>

export interface StatsProjectOption {
  key: string
  label: string
}

export interface StatsDashboard {
  summary: StatsDashboardSummary
  activity: StatsActivity
  projects: StatsProjectOption[]
}

export interface StatsModels {
  tokens: UsageTokens & { total: number }
  byModel: StatsModelBreakdownItem[]
  modelTrend: StatsModelTrendPoint[]
}

export type StatsExportView = 'overview' | 'models' | 'projects' | 'project'

export interface StatsExportCsvInput {
  view: StatsExportView
  query: StatsQuery
  projectPath?: string
}

export interface StatsExportCsvResult {
  cancelled: boolean
  path?: string
}

export interface ActivityDay {
  date: string
  prompts: number
}

export interface StatsActivity {
  days: ActivityDay[]
  activeDays: number
  currentStreak: number
  longestStreak: number
  totalPrompts: number
  byTool: StatsBreakdownItem[]
}

export interface GrowthAchievement {
  id: string
  title: string
  description: string
  unlocked: boolean
}

export interface DimensionScore {
  key: string
  label: string
  value: number        // 0-10
  insight: string
}

export interface StatsGrowth {
  /** 等级（1-100，来自 agent-life XP 曲线） */
  level: number
  /** 等级标题（新手探索者、学徒 … 超越者） */
  levelTitle: string
  /** 当前等级内经验值百分比 (0-100) */
  progressPct: number
  /** 下一级提示文本 */
  nextLevelHint: string
  /** XP 绝对值 */
  xp: number
  /** 当前级起始 XP */
  currentLevelXp: number
  /** 下一级起始 XP */
  nextLevelXp: number
  /** Cardex 维度评分 (0-10) */
  dimensions: DimensionScore[]
  /** 成就列表（与旧版兼容） */
  achievements: GrowthAchievement[]
  /** AI 洞察 */
  insights: string[]
  /** 总 CLI 交互次数 */
  cliInteractions: number
  /** 总会话数 */
  sessionCount: number
  /** 记忆条数 */
  memoriesCount: number
  /** 连续活跃周数 */
  streakWeeks: number
}

/** Cardex 本地图鉴状态（装备槽 + 已见解锁），后端持久化。 */
export interface CardexState {
  /** 已装备卡牌 id（最多 3 张） */
  equipped: string[]
  /** 已弹过解锁提示的卡牌 id */
  seenUnlocked: string[]
}
