import type { TaskSchedule } from '@shared/types'

export interface SemanticTaskIntent {
  title: string
  prompt: string
  schedule: TaskSchedule
}

export interface ParseOptions {
  now?: Date
  timeZone?: string
}

interface CalendarParts {
  year: number
  month: number
  day: number
}

const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const DATE_TOKEN =
  /(?:今天|今晚|明天|后天|\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日?)/
const INTERVAL_TOKEN = /每(?:隔)?\s*(\d+)\s*(分钟|分|小时|时)/
const RECURRENCE_TOKEN =
  /(?:每天|每日|每个?工作日|工作日|周一到周五|每周[一二三四五六日天]|每(?:隔)?\s*\d+\s*(?:分钟|分|小时|时))/
const TIME_TOKEN =
  /(?:(上午|下午|晚上|今晚|早上|中午)\s*)?(\d{1,2})(?:(?:\s*[:：]\s*(\d{1,2}))|(?:\s*点(?:\s*(\d{1,2})\s*分?)?))/
const INTENT_TOKEN = /(?:创建|新建|添加|安排|设定|设置|提醒|定时)/

function zonedParts(
  date: Date,
  timeZone: string
): CalendarParts & { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute')
  }
}

/** 把目标时区的墙上时间转换成 UTC；二次校正覆盖常见 DST 偏移。 */
function zonedDateToUtc(
  parts: CalendarParts & { hour: number; minute: number },
  timeZone: string
): Date {
  const wanted = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  let candidate = new Date(wanted)
  for (let i = 0; i < 2; i += 1) {
    const actual = zonedParts(candidate, timeZone)
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute
    )
    candidate = new Date(candidate.getTime() + wanted - actualAsUtc)
  }
  return candidate
}

function addDays(parts: CalendarParts, days: number): CalendarParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function isValidCalendarDate(parts: CalendarParts): boolean {
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return false
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() + 1 === parts.month &&
    date.getUTCDate() === parts.day
  )
}

function parseClock(match: RegExpMatchArray): { hour: number; minute: number } | null {
  const period = match[1]
  let hour = Number(match[2])
  const minute = Number(match[3] ?? match[4] ?? 0)
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null
  if (period) {
    if (hour < 1 || hour > 12) return null
    if (
      (period === '下午' || period === '晚上' || period === '今晚' || period === '中午') &&
      hour < 12
    )
      hour += 12
    if ((period === '上午' || period === '早上') && hour === 12) hour = 0
  } else if (hour < 0 || hour > 23) return null
  return { hour, minute }
}

function taskBody(text: string, timeText: string): string {
  return text
    .replace(timeText, ' ')
    .replace(DATE_TOKEN, ' ')
    .replace(RECURRENCE_TOKEN, ' ')
    .replace(/^(?:请|麻烦|帮我|请帮我)\s*/u, '')
    .replace(/(?:创建|新建|添加|安排|设定|设置)\s*(?:一个|一条)?/gu, ' ')
    .replace(/(?:定时|计划)\s*任务/gu, ' ')
    .replace(/(?:一次性|单次)/gu, ' ')
    .replace(/提醒(?:我)?/gu, ' ')
    .replace(/\btask\b/giu, ' ')
    .replace(/任务/gu, ' ')
    .replace(/^[\s，,。；;：:的在于到]+/u, '')
    .replace(/^(?:执行|运行|完成|做)(?:的)?\s*/u, '')
    .replace(/^[\s，,。；;：:的在于到]+/u, '')
    .replace(/(?:执行|运行|完成|做)\s*$/u, '')
    .replace(/[\s，,。；;：:的在于]+$/u, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\r?\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s，,。；;：:的在于到]+/u, '')
    .trim()
}

function onceDate(
  text: string,
  now: Date,
  timeZone: string,
  clock: { hour: number; minute: number }
): Date | null {
  const current = zonedParts(now, timeZone)
  let calendar: CalendarParts | null = null
  if (text.includes('后天')) calendar = addDays(current, 2)
  else if (text.includes('明天')) calendar = addDays(current, 1)
  else if (text.includes('今天') || text.includes('今晚')) calendar = addDays(current, 0)
  const iso = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (iso) calendar = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/)
  if (monthDay)
    calendar = { year: current.year, month: Number(monthDay[1]), day: Number(monthDay[2]) }
  if (!calendar || !isValidCalendarDate(calendar)) return null
  const candidate = zonedDateToUtc({ ...calendar, ...clock }, timeZone)
  if (!Number.isFinite(candidate.getTime())) return null
  if (candidate.getTime() <= now.getTime() && monthDay && !iso) {
    candidate.setTime(
      zonedDateToUtc({ ...calendar, year: calendar.year + 1, ...clock }, timeZone).getTime()
    )
  }
  return candidate.getTime() > now.getTime() ? candidate : null
}

export function parseSemanticTaskIntent(
  text: string,
  options: ParseOptions = {}
): SemanticTaskIntent | null {
  const source = text.trim()
  if (!source || !INTENT_TOKEN.test(source)) return null
  const interval = source.match(INTERVAL_TOKEN)
  const timeMatch = source.match(TIME_TOKEN)
  if (!timeMatch && !interval) return null
  const clock = timeMatch ? parseClock(timeMatch) : null
  if (timeMatch && !clock) return null
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = options.now ?? new Date()
  const body = taskBody(source, timeMatch?.[0] ?? '')
  if (!body) return null

  let schedule: TaskSchedule | null = null
  if (interval) {
    const amount = Number(interval[1])
    const unitMs = interval[2] === '小时' || interval[2] === '时' ? 60 * 60_000 : 60_000
    const everyMs = amount * unitMs
    if (!Number.isInteger(everyMs) || everyMs < 60_000 || everyMs > 30 * 24 * 60 * 60_000) {
      return null
    }
    schedule = {
      kind: 'interval',
      everyMs,
      anchorAt: now.toISOString(),
      timeZone,
      enabled: true,
      misfirePolicy: 'run_once'
    }
  } else if (clock && /(?:每天|每日)/.test(source)) {
    schedule = {
      kind: 'cron',
      expression: `${clock.minute} ${clock.hour} * * *`,
      timeZone,
      enabled: true,
      misfirePolicy: 'run_once'
    }
  } else if (clock && /(?:每个?工作日|工作日|周一到周五)/.test(source)) {
    schedule = {
      kind: 'cron',
      expression: `${clock.minute} ${clock.hour} * * 1-5`,
      timeZone,
      enabled: true,
      misfirePolicy: 'run_once'
    }
  } else {
    const weekly = clock ? source.match(/每周([一二三四五六日天])/) : null
    if (weekly && clock) {
      schedule = {
        kind: 'cron',
        expression: `${clock.minute} ${clock.hour} * * ${WEEKDAY[weekly[1]]}`,
        timeZone,
        enabled: true,
        misfirePolicy: 'run_once'
      }
    }
  }
  if (!schedule) {
    if (!DATE_TOKEN.test(source)) return null
    if (!clock) return null
    const runAt = onceDate(source, now, timeZone, clock)
    if (!runAt) return null
    schedule = {
      kind: 'once',
      runAt: runAt.toISOString(),
      timeZone,
      enabled: true,
      misfirePolicy: 'run_once'
    }
  }
  return { title: body.slice(0, 60), prompt: body, schedule }
}

function followUpTaskBody(text: string): string {
  return text
    .trim()
    .replace(/^(?:请|麻烦|帮我|请帮我)\s*/u, '')
    .replace(/^(?:任务)?(?:内容|事项)\s*(?:是|为|[:：])?\s*/u, '')
    .replace(/[\s，,。；;：:]+$/u, '')
    .trim()
}

/**
 * Completes an immediately preceding schedule-only request with the current task body.
 * The caller owns conversation recency/adjacency checks.
 */
export function parseSemanticTaskFollowUp(
  previousText: string,
  currentText: string,
  options: ParseOptions = {}
): SemanticTaskIntent | null {
  if (parseSemanticTaskIntent(previousText, options)) return null
  if (/^(?:好的?|可以|确认|继续(?:创建)?|是的?|没问题)[！!。.\s]*$/u.test(currentText.trim())) {
    return null
  }
  const placeholder = 'AGENT_OS_SEMANTIC_TASK_BODY'
  const partial = parseSemanticTaskIntent(`${previousText}\n${placeholder}`, options)
  const body = followUpTaskBody(currentText)
  if (!partial || !body) return null
  return {
    title: body.slice(0, 60),
    prompt: body,
    schedule: partial.schedule
  }
}
