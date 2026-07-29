import { describe, expect, it } from 'vitest'
import {
  advanceSchedule,
  nextIntervalOccurrence,
  nextCronOccurrence,
  normalizeSchedule,
  parseCronExpression
} from '../src/main/domains/tasks/cron'

describe('task cron', () => {
  it('calculates the next UTC occurrence for a five-field expression', () => {
    expect(
      nextCronOccurrence('30 9 * * *', 'UTC', new Date('2026-07-18T09:30:00.000Z')).toISOString()
    ).toBe('2026-07-19T09:30:00.000Z')
  })

  it('honours weekday ranges and target time zones', () => {
    expect(
      nextCronOccurrence(
        '0 9 * * 1-5',
        'Asia/Shanghai',
        new Date('2026-07-17T01:00:00.000Z')
      ).toISOString()
    ).toBe('2026-07-20T01:00:00.000Z')
  })

  it('uses standard day-of-month/day-of-week OR semantics', () => {
    expect(
      nextCronOccurrence('0 8 20 * 1', 'UTC', new Date('2026-07-18T00:00:00.000Z')).toISOString()
    ).toBe('2026-07-20T08:00:00.000Z')
  })

  it('rejects invalid expressions and time zones', () => {
    expect(() => parseCronExpression('0 24 * * *')).toThrow()
    expect(() => nextCronOccurrence('0 9 * * *', 'Mars/Base', new Date())).toThrow()
  })

  it('keeps a past one-off occurrence pending for misfire handling', () => {
    expect(
      normalizeSchedule(
        {
          kind: 'once',
          runAt: '2026-07-18T08:00:00.000Z',
          timeZone: 'UTC',
          enabled: true,
          misfirePolicy: 'run_once'
        },
        new Date('2026-07-18T09:00:00.000Z')
      )
    ).toMatchObject({ enabled: true, nextRunAt: '2026-07-18T08:00:00.000Z' })
  })

  it('normalizes and advances fixed intervals from a stable anchor', () => {
    const schedule = normalizeSchedule(
      {
        kind: 'interval',
        everyMs: 30 * 60_000,
        anchorAt: '2026-07-18T08:00:00.000Z',
        timeZone: 'UTC',
        enabled: true,
        misfirePolicy: 'run_once'
      },
      new Date('2026-07-18T09:10:00.000Z')
    )
    expect(schedule).toMatchObject({
      kind: 'interval',
      nextRunAt: '2026-07-18T09:30:00.000Z'
    })
    expect(advanceSchedule(schedule, new Date('2026-07-18T11:31:00.000Z')).nextRunAt).toBe(
      '2026-07-18T12:00:00.000Z'
    )
    expect(
      nextIntervalOccurrence(
        new Date('2026-07-18T12:00:00.000Z'),
        2 * 60 * 60_000,
        new Date('2026-07-18T11:00:00.000Z')
      ).toISOString()
    ).toBe('2026-07-18T12:00:00.000Z')
  })

  it('rejects unsafe intervals and keeps disabled intervals unscheduled', () => {
    expect(() =>
      normalizeSchedule({
        kind: 'interval',
        everyMs: 30_000,
        anchorAt: '2026-07-18T08:00:00.000Z',
        timeZone: 'UTC',
        enabled: true,
        misfirePolicy: 'skip'
      })
    ).toThrow('1 分钟到 30 天')
    expect(
      normalizeSchedule({
        kind: 'interval',
        everyMs: 2 * 60 * 60_000,
        anchorAt: '2026-07-18T08:00:00.000Z',
        timeZone: 'UTC',
        enabled: false,
        misfirePolicy: 'skip'
      }).nextRunAt
    ).toBeUndefined()
  })
})
