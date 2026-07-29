const BOTTOM_THRESHOLD_PX = 48

export interface ChatScrollSnapshot {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  forceFollow: boolean
}

export function shouldAutoFollowChatScroll(snapshot: ChatScrollSnapshot): boolean {
  if (snapshot.forceFollow) return true
  const distanceFromBottom = snapshot.scrollHeight - snapshot.scrollTop - snapshot.clientHeight
  return distanceFromBottom <= BOTTOM_THRESHOLD_PX
}
