import { describe, expect, it } from 'vitest'
import { calculateGrowth } from '../src/main/domains/stats/growth'

describe('growth rules (agent-life XP curve)', () => {
  it('XP 曲线随使用量单调递增等级', () => {
    const novice = calculateGrowth({
      activeDays: 1,
      sessions: 1,
      prompts: 1,
      favoriteTool: 'claude',
      peakHour: 10
    })
    const veteran = calculateGrowth({
      activeDays: 30,
      sessions: 50,
      prompts: 500,
      favoriteTool: 'claude',
      peakHour: 10,
      agentDiversity: 3,
      memoriesCount: 20
    })
    // 更多使用量 → 更高等级
    expect(veteran.level).toBeGreaterThan(novice.level)
    expect(veteran.xp).toBeGreaterThan(novice.xp)
  })

  it('成就阈值边界正确解锁', () => {
    const below = calculateGrowth({
      activeDays: 6,
      sessions: 9,
      prompts: 49,
      favoriteTool: 'claude',
      peakHour: 10
    })
    const reached = calculateGrowth({
      activeDays: 7,
      sessions: 10,
      prompts: 50,
      favoriteTool: 'claude',
      peakHour: 22
    })
    expect(below.achievements.find((a) => a.id === 'active-week')?.unlocked).toBe(false)
    expect(reached.achievements.filter((item) => item.unlocked).map((item) => item.id)).toEqual(
      expect.arrayContaining(['active-week', 'ten-sessions', 'fifty-prompts'])
    )
    expect(reached.insights).toContain('你最常在深夜使用 AI，注意劳逸结合。')
  })

  it('维度评分在 0-10 范围内', () => {
    const result = calculateGrowth({
      activeDays: 100,
      sessions: 200,
      prompts: 2000,
      favoriteTool: 'claude',
      peakHour: 14,
      agentDiversity: 4,
      memoriesCount: 50
    })
    expect(result.dimensions.length).toBe(5)
    for (const dim of result.dimensions) {
      expect(dim.value).toBeGreaterThanOrEqual(0)
      expect(dim.value).toBeLessThanOrEqual(10)
      expect(dim.insight.length).toBeGreaterThan(0)
    }
  })
})
