import type { TaskSchedule } from '@shared/types'

export const MIN_INTERVAL_MS = 60_000
export const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

interface CronField {
  values: Set<number>
  wildcard: boolean
}

export interface ParsedCronExpression {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

interface ZonedParts {
  minute: number
  hour: number
  dayOfMonth: number
  month: number
  dayOfWeek: number
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
  } catch {
    throw new Error(`无效时区：${timeZone}`)
  }
}

function parseNumber(raw: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} 含无效值：${raw}`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} 超出范围 ${min}-${max}：${raw}`)
  }
  return value
}

function parseField(
  raw: string,
  min: number,
  max: number,
  label: string,
  normalize: (value: number) => number = (value) => value
): CronField {
  const values = new Set<number>()
  const wildcard = raw === '*'
  for (const segment of raw.split(',')) {
    if (!segment) throw new Error(`${label} 含空列表项`)
    const [base, stepRaw, extra] = segment.split('/')
    if (extra !== undefined) throw new Error(`${label} 步长格式无效：${segment}`)
    const step = stepRaw === undefined ? 1 : parseNumber(stepRaw, 1, max - min + 1, label)
    let start: number
    let end: number
    if (base === '*') {
      start = min
      end = max
    } else if (base.includes('-')) {
      const [left, right, third] = base.split('-')
      if (third !== undefined) throw new Error(`${label} 范围格式无效：${segment}`)
      start = parseNumber(left, min, max, label)
      end = parseNumber(right, min, max, label)
      if (start > end) throw new Error(`${label} 范围起点大于终点：${segment}`)
    } else {
      start = parseNumber(base, min, max, label)
      end = start
      if (stepRaw !== undefined) throw new Error(`${label} 单值不能使用步长：${segment}`)
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value))
  }
  if (values.size === 0) throw new Error(`${label} 没有可用值`)
  return { values, wildcard }
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron 必须是五段：minute hour day month weekday')
  return {
    minute: parseField(fields[0], 0, 59, '分钟'),
    hour: parseField(fields[1], 0, 23, '小时'),
    dayOfMonth: parseField(fields[2], 1, 31, '日期'),
    month: parseField(fields[3], 1, 12, '月份'),
    dayOfWeek: parseField(fields[4], 0, 7, '星期', (value) => (value === 7 ? 0 : value))
  }
}

function partsAt(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(date)
  const map = new Map(parts.map((part) => [part.type, part.value]))
  const weekday = WEEKDAYS[map.get('weekday') ?? '']
  if (weekday === undefined) throw new Error(`无法解析时区日期：${timeZone}`)
  return {
    minute: Number(map.get('minute')),
    hour: Number(map.get('hour')),
    dayOfMonth: Number(map.get('day')),
    month: Number(map.get('month')),
    dayOfWeek: weekday
  }
}

export function cronMatches(parsed: ParsedCronExpression, parts: ZonedParts): boolean {
  if (!parsed.minute.values.has(parts.minute)) return false
  if (!parsed.hour.values.has(parts.hour)) return false
  if (!parsed.month.values.has(parts.month)) return false
  const dom = parsed.dayOfMonth.values.has(parts.dayOfMonth)
  const dow = parsed.dayOfWeek.values.has(parts.dayOfWeek)
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true
  if (parsed.dayOfMonth.wildcard) return dow
  if (parsed.dayOfWeek.wildcard) return dom
  // 标准 cron：day-of-month 与 day-of-week 同时受限时采用 OR。
  return dom || dow
}

export function nextCronOccurrence(
  expression: string,
  timeZone: string,
  after: Date,
  maxMinutes = 366 * 24 * 60
): Date {
  assertTimeZone(timeZone)
  const parsed = parseCronExpression(expression)
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000
  for (let offset = 0; offset < maxMinutes; offset += 1) {
    const candidate = new Date(start + offset * 60_000)
    if (cronMatches(parsed, partsAt(candidate, timeZone))) return candidate
  }
  throw new Error('cron 在未来 366 天内没有可执行时间')
}

export function normalizeSchedule(schedule: TaskSchedule, now = new Date()): TaskSchedule {
  assertTimeZone(schedule.timeZone)
  if (schedule.kind === 'once') {
    const runAt = new Date(schedule.runAt)
    if (!Number.isFinite(runAt.getTime())) throw new Error('单次执行时间无效')
    return {
      ...schedule,
      runAt: runAt.toISOString(),
      nextRunAt: schedule.enabled ? runAt.toISOString() : undefined
    }
  }
  if (schedule.kind === 'interval') {
    if (
      !Number.isInteger(schedule.everyMs) ||
      schedule.everyMs < MIN_INTERVAL_MS ||
      schedule.everyMs > MAX_INTERVAL_MS
    ) {
      throw new Error('间隔必须是 1 分钟到 30 天之间的整数毫秒')
    }
    const anchorAt = new Date(schedule.anchorAt)
    if (!Number.isFinite(anchorAt.getTime())) throw new Error('间隔基准时间无效')
    return {
      ...schedule,
      anchorAt: anchorAt.toISOString(),
      nextRunAt: schedule.enabled
        ? nextIntervalOccurrence(anchorAt, schedule.everyMs, now).toISOString()
        : undefined
    }
  }
  parseCronExpression(schedule.expression)
  return {
    ...schedule,
    expression: schedule.expression.trim().replace(/\s+/g, ' '),
    nextRunAt: schedule.enabled
      ? nextCronOccurrence(schedule.expression, schedule.timeZone, now).toISOString()
      : undefined
  }
}

export function advanceSchedule(schedule: TaskSchedule, after: Date): TaskSchedule {
  if (schedule.kind === 'once') return { ...schedule, enabled: false, nextRunAt: undefined }
  if (!schedule.enabled) return { ...schedule, nextRunAt: undefined }
  if (schedule.kind === 'interval') {
    return {
      ...schedule,
      nextRunAt: nextIntervalOccurrence(
        new Date(schedule.anchorAt),
        schedule.everyMs,
        after
      ).toISOString()
    }
  }
  return {
    ...schedule,
    nextRunAt: nextCronOccurrence(schedule.expression, schedule.timeZone, after).toISOString()
  }
}

export function nextIntervalOccurrence(anchorAt: Date, everyMs: number, after: Date): Date {
  if (!Number.isFinite(anchorAt.getTime())) throw new Error('间隔基准时间无效')
  if (!Number.isInteger(everyMs) || everyMs < MIN_INTERVAL_MS || everyMs > MAX_INTERVAL_MS) {
    throw new Error('间隔必须是 1 分钟到 30 天之间的整数毫秒')
  }
  if (!Number.isFinite(after.getTime())) throw new Error('间隔推进时间无效')
  const elapsed = after.getTime() - anchorAt.getTime()
  const steps = elapsed < 0 ? 0 : Math.floor(elapsed / everyMs) + 1
  return new Date(anchorAt.getTime() + steps * everyMs)
}
