import { describe, expect, it } from 'vitest'
import { messageTime } from '../src/shared/message-time'

describe('message time presentation', () => {
  it('uses local day boundaries and exposes a full zoned timestamp', () => {
    const now = new Date('2026-08-26T12:00:00.000Z')

    expect(messageTime('2026-08-26T11:05:09.000Z', now, 'Asia/Shanghai')).toEqual({
      short: '19:05',
      full: '2026-08-26 19:05:09 GMT+08:00'
    })
    expect(messageTime('2026-08-25T15:59:00.000Z', now, 'Asia/Shanghai')?.short).toBe(
      '2026-08-25 23:59'
    )
    expect(messageTime('2026-08-26T11:05:09.000Z', now, 'America/New_York')).toEqual({
      short: '07:05',
      full: '2026-08-26 07:05:09 GMT-04:00'
    })
    expect(messageTime('invalid', now, 'Asia/Shanghai')).toBeNull()
  })
})
