// SPEC-034：按账号平台把统一 ChannelTransport 契约分发到各官方 SDK。

import type { ChannelAccount, ChannelAccountStatus, ChannelPlatform } from '@shared/types'
import type {
  ChannelTransport,
  InboundChannelMessage,
  OnboardingCallbacks,
  OnboardingResult
} from './transport'

export class MultiplexChannelTransport implements ChannelTransport {
  private readonly accountPlatforms = new Map<string, ChannelPlatform>()
  private messageCb: ((msg: InboundChannelMessage) => void | Promise<void>) | null = null
  private statusCb: ((accountId: string, status: ChannelAccountStatus, error?: string) => void) | null = null

  constructor(private readonly transports: Partial<Record<ChannelPlatform, ChannelTransport>>) {
    for (const transport of Object.values(transports)) {
      transport?.onMessage(async (msg) => { await this.messageCb?.(msg) })
      transport?.onStatus((accountId, status, error) => this.statusCb?.(accountId, status, error))
    }
  }

  onMessage(cb: (msg: InboundChannelMessage) => void | Promise<void>): void {
    this.messageCb = cb
  }

  onStatus(cb: (accountId: string, status: ChannelAccountStatus, error?: string) => void): void {
    this.statusCb = cb
  }

  async start(account: ChannelAccount): Promise<void> {
    const transport = this.transports[account.platform]
    if (!transport) throw new Error(`消息平台 ${account.platform} 尚未提供可用 transport`)
    this.accountPlatforms.set(account.id, account.platform)
    await transport.start(account)
  }

  async stop(accountId: string): Promise<void> {
    const transport = this.transportFor(accountId)
    if (!transport) return
    await transport.stop(accountId)
    this.accountPlatforms.delete(accountId)
  }

  send(input: Parameters<ChannelTransport['send']>[0]): ReturnType<ChannelTransport['send']> {
    const transport = this.requireTransport(input.accountId)
    return transport.send(input)
  }

  updateMessage(input: NonNullable<Parameters<NonNullable<ChannelTransport['updateMessage']>>[0]>): Promise<void> {
    const transport = this.requireTransport(input.accountId)
    if (!transport.updateMessage) throw new Error('当前消息平台不支持更新已有消息')
    return transport.updateMessage(input)
  }

  canUpdate(accountId: string): boolean {
    const transport = this.transportFor(accountId)
    return Boolean(transport?.updateMessage) && (transport?.canUpdate?.(accountId) ?? true)
  }

  getUserDisplayName(accountId: string, userId: string): Promise<string | null> {
    const transport = this.transportFor(accountId)
    return transport?.getUserDisplayName?.(accountId, userId) ?? Promise.resolve(null)
  }

  materializeInboundAttachments(
    message: InboundChannelMessage
  ): ReturnType<NonNullable<ChannelTransport['materializeInboundAttachments']>> {
    const transport = this.requireTransport(message.accountId)
    if (!transport.materializeInboundAttachments) return Promise.resolve(null)
    return transport.materializeInboundAttachments(message)
  }

  async restoreInboundContext(message: InboundChannelMessage): Promise<void> {
    const transport = this.requireTransport(message.accountId)
    await transport.restoreInboundContext?.(message)
  }

  startOnboarding(
    callbacks: OnboardingCallbacks,
    platform: ChannelPlatform = 'feishu'
  ): Promise<OnboardingResult> {
    const transport = this.transports[platform]
    if (!transport?.startOnboarding) throw new Error(`${platform} 扫码接入当前不可用`)
    return transport.startOnboarding(callbacks, platform)
  }

  private transportFor(accountId: string): ChannelTransport | undefined {
    const platform = this.accountPlatforms.get(accountId)
    return platform ? this.transports[platform] : undefined
  }

  private requireTransport(accountId: string): ChannelTransport {
    const transport = this.transportFor(accountId)
    if (!transport) throw new Error(`消息账号 ${accountId} 未连接或平台不受支持`)
    return transport
  }
}
