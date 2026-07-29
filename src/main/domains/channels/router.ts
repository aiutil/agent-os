// SPEC-034 消息渠道 —— 路由（入站消息 → 绑定/会话解析）。
// 把一个外部会话（platform+account+chatType+chatId）解析到一个 Conversation 绑定：
// 已有绑定直接复用；无则按默认 agent 建一个 source:'channel' 的对话会话并落库绑定。
// 这样同一飞书会话多轮连续，上下文不丢。

import type { ChannelBinding, WorkbenchSession } from '@shared/types'
import type { InboundChannelMessage } from './transport'

export interface CreateChannelSessionInput {
  toolId: string
  workspacePath: string
  name: string
  channelBinding: {
    platform: ChannelBinding['platform']
    accountId: string
    chatType: ChannelBinding['chatType']
    chatId: string
  }
}

export interface RouterDeps {
  listBindings(): ChannelBinding[]
  saveBinding(binding: ChannelBinding): void
  createChannelSession(input: CreateChannelSessionInput): Promise<WorkbenchSession>
  /** 选默认 agent（首个支持结构化聊天的 CLI + 其默认工作目录）。 */
  pickDefaultAgent(): Promise<{ toolId: string; workspacePath: string; name: string } | null>
}

/** 绑定唯一键（用于查找/去重）。 */
export function bindingKey(
  platform: string,
  accountId: string,
  chatType: string,
  chatId: string
): string {
  return `${platform}:${accountId}:${chatType}:${chatId}`
}

export function findBinding(
  deps: RouterDeps,
  msg: Pick<InboundChannelMessage, 'platform' | 'accountId' | 'chatType' | 'chatId'>
): ChannelBinding | undefined {
  return deps.listBindings().find(
    (b) => bindingKey(b.platform, b.accountId, b.chatType, b.chatId) === bindingKey(msg.platform, msg.accountId, msg.chatType, msg.chatId)
  )
}

/** 解析绑定：有则复用，无则建会话 + 落绑定。 */
export async function resolveBinding(deps: RouterDeps, msg: InboundChannelMessage): Promise<ChannelBinding> {
  const existing = findBinding(deps, msg)
  if (existing) return existing
  const agent = await deps.pickDefaultAgent()
  if (!agent) {
    throw new Error('未发现支持结构化聊天的 CLI（请在 Agent OS 里先装好 claude/codex/opencode 等并完成发现）')
  }
  const session = await deps.createChannelSession({
    toolId: agent.toolId,
    workspacePath: agent.workspacePath,
    name: `${msg.platform} · …${msg.chatId.slice(-6)}`,
    channelBinding: {
      platform: msg.platform,
      accountId: msg.accountId,
      chatType: msg.chatType,
      chatId: msg.chatId
    }
  })
  const binding: ChannelBinding = {
    platform: msg.platform,
    accountId: msg.accountId,
    chatType: msg.chatType,
    chatId: msg.chatId,
    conversationId: session.id,
    toolId: agent.toolId,
    workspacePath: agent.workspacePath,
    // 初始化该 agent 的持久会话映射；/use 切到别的 agent 再切回来时能复用。
    sessions: { [agent.toolId]: session.id }
  }
  deps.saveBinding(binding)
  return binding
}
