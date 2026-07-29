import { randomUUID } from 'node:crypto'
import type { AnalyticsEvent, AnalyticsEventEnvelope } from '@shared/types'

/**
 * 主进程事件与 renderer SDK 解耦。事件先入有界队列再 best-effort 推送；renderer
 * 初始化后 drain，并按 envelope id 去重，避免窗口尚未 ready 时丢失 Value Moment。
 */
export class AnalyticsEventBus {
  private readonly pending: AnalyticsEventEnvelope[] = []
  private rendererReady = false

  constructor(
    private readonly emit: (event: AnalyticsEventEnvelope) => void,
    private readonly maxPending = 200,
    private enabled = true
  ) {}

  publish(event: AnalyticsEvent): AnalyticsEventEnvelope {
    const envelope = { id: randomUUID(), event }
    if (!this.enabled) return envelope
    if (!this.rendererReady) {
      this.pending.push(envelope)
      if (this.pending.length > this.maxPending)
        this.pending.splice(0, this.pending.length - this.maxPending)
    }
    this.emit(envelope)
    return envelope
  }

  drain(): AnalyticsEventEnvelope[] {
    this.rendererReady = true
    return this.pending.splice(0)
  }

  /** renderer reload 期间重新缓存；初始化完成后的 drain 会恢复 ready。 */
  pause(): void {
    this.rendererReady = false
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.rendererReady = false
    if (!enabled) this.pending.splice(0)
  }

  clear(): void {
    this.pending.splice(0)
    this.rendererReady = false
  }
}
