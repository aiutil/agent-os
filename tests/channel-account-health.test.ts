import { describe, expect, it } from 'vitest'
import type { ChannelAccount } from '../src/shared/types/channels'
import {
  aggregateChannelExperience,
  channelAccountExperience,
  channelHeaderExperience,
  selectChannelAccount
} from '../src/shared/channel-account-health'

function account(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: overrides.id ?? 'account-1',
    platform: overrides.platform ?? 'feishu',
    alias: overrides.alias ?? 'bot',
    enabled: overrides.enabled ?? true,
    credentials: overrides.credentials ?? {},
    ...overrides
  }
}

describe('channel account experience state', () => {
  it.each([
    [account({ enabled: false, status: 'online' }), 'disabled'],
    [account({ status: 'error' }), 'error'],
    [account({ status: 'online', error: 'invalid token' }), 'error'],
    [account({ status: 'disconnected' }), 'disconnected'],
    [account({ status: 'connecting' }), 'connecting'],
    [account({ status: 'online' }), 'awaiting-first-message'],
    [account({ status: 'online', health: { lastInboundAt: '2026-07-19T01:00:00Z' } }), 'awaiting-completion'],
    [account({ status: 'online', health: { lastTurnCompletedAt: '2026-07-19T01:00:00Z' } }), 'verified'],
    [account({ status: 'online', health: { lastTurnCompletedAt: '2026-07-19T01:00:00Z', lastErrorAt: '2026-07-19T02:00:00Z' } }), 'awaiting-first-message']
  ] as const)('derives %s without treating configuration as connectivity', (input, expected) => {
    expect(channelAccountExperience(input)).toBe(expected)
  })

  it('surfaces the account that needs the most attention instead of hiding it behind a verified account', () => {
    expect(aggregateChannelExperience([
      account({ id: 'verified', status: 'online', health: { lastTurnCompletedAt: '2026-07-19T01:00:00Z' } }),
      account({ id: 'broken', status: 'error' })
    ])).toBe('error')
  })

  it('keeps the preferred account selected and falls back after it is removed', () => {
    const first = account({ id: 'first' })
    const second = account({ id: 'second' })
    expect(selectChannelAccount([first, second], 'second')?.id).toBe('second')
    expect(selectChannelAccount([first], 'second')?.id).toBe('first')
    expect(selectChannelAccount([], 'second')).toBeUndefined()
  })

  it('uses an explicit adding state instead of leaking the selected account health into a new-account form', () => {
    const verified = account({ status: 'online', health: { lastTurnCompletedAt: '2026-07-19T01:00:00Z' } })
    expect(channelHeaderExperience(verified, true)).toEqual({ mode: 'adding' })
    expect(channelHeaderExperience(verified, false)).toEqual({ mode: 'account', state: 'verified', error: undefined })
    expect(channelHeaderExperience(undefined, false)).toEqual({ mode: 'unconfigured' })
  })
})
