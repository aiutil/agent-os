import { describe, expect, it } from 'vitest'
import {
  parseSemanticTaskFollowUp,
  parseSemanticTaskIntent
} from '../src/main/domains/tasks/semantic-schedule'

const now = new Date('2026-07-22T02:00:00.000Z') // Asia/Shanghai 10:00
const options = { now, timeZone: 'Asia/Shanghai' }

describe('Agent 对话语义定时', () => {
  it('把明天的明确任务解析为一次性计划', () => {
    expect(
      parseSemanticTaskIntent('帮我创建一个明天8点执行检查服务状态的任务', options)
    ).toMatchObject({
      title: '检查服务状态',
      prompt: '检查服务状态',
      schedule: {
        kind: 'once',
        runAt: '2026-07-23T00:00:00.000Z',
        timeZone: 'Asia/Shanghai',
        enabled: true
      }
    })
  })

  it.each([
    ['每天上午9点提醒我生成日报', '0 9 * * *'],
    ['每个工作日18:30创建整理当天告警任务', '30 18 * * 1-5'],
    ['每周一上午10点安排检查发布状态', '0 10 * * 1']
  ])('解析周期计划：%s', (text, expression) => {
    expect(parseSemanticTaskIntent(text, options)?.schedule).toMatchObject({
      kind: 'cron',
      expression,
      timeZone: 'Asia/Shanghai'
    })
  })

  it.each([
    ['创建任务，每隔30分钟检查 ISSUE', 30 * 60_000, '检查 ISSUE'],
    ['新建一个每 2 小时执行的任务：同步发布状态', 2 * 60 * 60_000, '同步发布状态']
  ])('解析固定间隔计划：%s', (text, everyMs, prompt) => {
    expect(parseSemanticTaskIntent(text, options)).toMatchObject({
      prompt,
      schedule: {
        kind: 'interval',
        everyMs,
        anchorAt: now.toISOString(),
        timeZone: 'Asia/Shanghai',
        enabled: true
      }
    })
  })

  it('保留语义任务正文中的显式换行', () => {
    expect(
      parseSemanticTaskIntent('每天上午9点创建任务：检查服务\n输出失败原因', options)?.prompt
    ).toBe('检查服务\n输出失败原因')
  })

  it.each([
    '明天8点天气怎么样',
    '帮我创建一个明天8点的任务',
    '帮我创建一个昨天8点执行检查服务的任务',
    '帮我创建一个明天25点执行检查服务的任务',
    '帮我创建一个2026-02-31 8点执行检查服务的任务'
  ])('不对含糊或非法文本静默建任务：%s', (text) => {
    expect(parseSemanticTaskIntent(text, options)).toBeNull()
  })

  it('把“今晚”解释为今天晚上，但缺少正文时等待下一轮补全', () => {
    const previous = '设置一次性任务今晚9点执行'
    expect(parseSemanticTaskIntent(previous, options)).toBeNull()
    expect(parseSemanticTaskFollowUp(previous, '分析本项目未完成的ISSUE', options)).toMatchObject({
      title: '分析本项目未完成的ISSUE',
      prompt: '分析本项目未完成的ISSUE',
      schedule: {
        kind: 'once',
        runAt: '2026-07-22T13:00:00.000Z',
        timeZone: 'Asia/Shanghai'
      }
    })
  })

  it('不会用普通确认词充当任务正文', () => {
    expect(parseSemanticTaskFollowUp('设置一次性任务今晚9点执行', '继续创建', options)).toBeNull()
  })
})
