import type { ManagedChatMessage, WorkbenchSession } from '@shared/types'
import { MemoryCurationService } from './curation'

const IDLE_DELAY_MS = 15 * 60 * 1000

/**
 * 自建聊天通道在成功完成后延迟提炼。定时器 unref，不会阻止桌面应用退出；设置未启用
 * 或 curator 缺失时 service 会安全拒绝，原始会话仍由既有证据索引保留。
 */
export class MemoryCurationScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly curation: MemoryCurationService) {}

  schedule(session: WorkbenchSession, messages: ManagedChatMessage[]): void {
    if (session.memoryGenerate === false) return
    const sourceId = session.nativeSessionId
      ? `${session.toolId}:${session.nativeSessionId}`
      : `agent:${session.id}`
    this.cancel(sourceId)
    const text = messages
      .filter((message) => message.status === 'completed' && (message.role === 'user' || message.role === 'assistant'))
      .map((message) => `## ${message.role}\n${message.text}`)
      .filter((block) => block.trim().length > 8)
      .join('\n\n')
    if (!text) return
    const timer = setTimeout(() => {
      this.timers.delete(sourceId)
      void this.curation.curate({
        sourceId,
        cwd: session.workspacePath,
        text,
        // IM 渠道会话提炼出的记忆落到 user scope + 渠道标签，全渠道 agent 共享、UI 可筛选。
        ...(session.source === 'channel' && session.channelBinding?.platform
          ? { channelTag: session.channelBinding.platform }
          : {})
      }).catch(() => {
        // 自动提炼是增强能力；失败不能影响会话、运行时或之后的手动提炼。
      })
    }, IDLE_DELAY_MS)
    timer.unref()
    this.timers.set(sourceId, timer)
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private cancel(sourceId: string): void {
    const previous = this.timers.get(sourceId)
    if (previous) clearTimeout(previous)
    this.timers.delete(sourceId)
  }
}
