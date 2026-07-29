// 活动点阵热力图共享逻辑：等级阈值 + 淡蓝色阶。
// 会话二级面板底部（ActivityHeat）为基准样式，统计页与成长页共用，
// 保证同一天的活跃强度在各处呈现相同的等级与配色。

/** 将单日用户提示数映射为 0-5 热力等级（与会话面板一致）。 */
export function heatLevel(p: number): number {
  return p === 0 ? 0 : p < 3 ? 1 : p < 8 ? 2 : p < 15 ? 3 : p < 20 ? 4 : 5
}

/** 淡蓝色热力色阶（对应 v3.css 的 --heat-0..5）。索引即等级。 */
export const HEAT_COLORS = [
  'var(--heat-0)',
  'var(--heat-1)',
  'var(--heat-2)',
  'var(--heat-3)',
  'var(--heat-4)',
  'var(--heat-5)'
] as const
