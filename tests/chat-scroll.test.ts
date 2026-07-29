import { describe, expect, it } from 'vitest'
import { shouldAutoFollowChatScroll } from '../src/shared/chat-scroll'

describe('chat scroll follow policy', () => {
  it('keeps following when the user is near the bottom', () => {
    expect(
      shouldAutoFollowChatScroll({
        scrollTop: 940,
        scrollHeight: 1200,
        clientHeight: 240,
        forceFollow: false
      })
    ).toBe(true)
  })

  it('does not force-follow after the user scrolls away from the bottom', () => {
    expect(
      shouldAutoFollowChatScroll({
        scrollTop: 120,
        scrollHeight: 1200,
        clientHeight: 240,
        forceFollow: false
      })
    ).toBe(false)
  })

  it('allows explicit send or jump-to-latest actions to force-follow', () => {
    expect(
      shouldAutoFollowChatScroll({
        scrollTop: 120,
        scrollHeight: 1200,
        clientHeight: 240,
        forceFollow: true
      })
    ).toBe(true)
  })
})
