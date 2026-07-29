import type { ChannelAccount } from './types'

export type ChannelExperienceState =
  | 'disabled'
  | 'error'
  | 'disconnected'
  | 'connecting'
  | 'awaiting-first-message'
  | 'awaiting-completion'
  | 'verified'

export type ChannelHeaderExperience =
  | { mode: 'adding' }
  | { mode: 'unconfigured' }
  | { mode: 'account'; state: ChannelExperienceState; error?: string }

const EXPERIENCE_PRIORITY: Record<ChannelExperienceState, number> = {
  error: 60,
  disconnected: 50,
  connecting: 40,
  'awaiting-completion': 30,
  'awaiting-first-message': 20,
  disabled: 10,
  verified: 0
}

/**
 * Derives the user-facing account state from transport state plus end-to-end
 * health. A configured record is intentionally not treated as a connection.
 */
export function channelAccountExperience(account: ChannelAccount): ChannelExperienceState {
  if (!account.enabled) return 'disabled'
  if (account.status === 'error' || account.error) return 'error'
  if (!account.status || account.status === 'disconnected') return 'disconnected'
  if (account.status === 'connecting') return 'connecting'

  const completedAt = account.health?.lastTurnCompletedAt
  const errorAt = account.health?.lastErrorAt
  const verified = Boolean(completedAt && (!errorAt || completedAt >= errorAt))
  if (verified) return 'verified'
  if (account.health?.lastInboundAt) return 'awaiting-completion'
  return 'awaiting-first-message'
}

/** Returns the state that most needs attention for a platform account group. */
export function aggregateChannelExperience(accounts: ChannelAccount[]): ChannelExperienceState | undefined {
  let result: ChannelExperienceState | undefined
  for (const account of accounts) {
    const current = channelAccountExperience(account)
    if (!result || EXPERIENCE_PRIORITY[current] > EXPERIENCE_PRIORITY[result]) result = current
  }
  return result
}

/** Keeps a selected account stable while falling back safely after removal. */
export function selectChannelAccount(accounts: ChannelAccount[], preferredId?: string): ChannelAccount | undefined {
  return accounts.find((account) => account.id === preferredId) ?? accounts[0]
}

/** Prevents an existing account's health from leaking into the add-account flow. */
export function channelHeaderExperience(account: ChannelAccount | undefined, addingAccount: boolean): ChannelHeaderExperience {
  if (addingAccount) return { mode: 'adding' }
  if (!account) return { mode: 'unconfigured' }
  return { mode: 'account', state: channelAccountExperience(account), error: account.error }
}
