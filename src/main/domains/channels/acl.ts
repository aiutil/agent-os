// SPEC-034 消息渠道 —— 访问控制。
// 新账号显式 owner-first；缺少 mode 的存量记录保持 legacy-open，避免升级后静默断流，
// 由设置页提示用户收紧。

import type { ChannelAcl } from '@shared/types'

/** 该 userId 是否被允许驱动本账号。 */
export function isAllowed(acl: ChannelAcl | undefined, userId: string): boolean {
  if (!acl?.mode) return !acl || acl.allowlist.length === 0 || acl.allowlist.includes(userId)
  if (acl.mode === 'open') return true
  if (acl.mode === 'owner') return Boolean(acl.ownerId && acl.ownerId === userId)
  return acl.allowlist.includes(userId)
}
