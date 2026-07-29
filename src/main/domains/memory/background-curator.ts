import type { CurationCandidate, NormalizedTranscript } from '@shared/types'
import type { MemoryCurationService } from './curation'
import type { MemoryVault } from './vault'
import type { MemoryWorkerClient } from './worker-client'

/** 会话至少空闲这么久才进入自动提炼（避免对进行中的会话反复提炼）。 */
const IDLE_MS = 15 * 60 * 1000
/** 同一会话两次自动提炼的最小间隔（跨链路去重，配合水位线增量判断）。 */
const COOLDOWN_MS = 6 * 60 * 60 * 1000
/** 相对上次水位线至少新增这么多条消息，才值得再次提炼。 */
const MIN_NEW_MESSAGES = 4
/** 每轮最多实际提炼的会话数，限制并发 CLI 子进程开销。 */
const BATCH_PER_TICK = 3
/** 每轮从索引拉取的候选上限。 */
const CANDIDATE_LIMIT = 60
/** 单会话连续失败到此次数后本进程内不再重试（避免坏会话拖垮调度）。 */
const MAX_FAILURES = 2
/** 周期巡检间隔。 */
const TICK_MS = 10 * 60 * 1000
/** 启动后首轮巡检延迟，给索引初次 reconcile 留出时间。 */
const FIRST_TICK_DELAY_MS = 60 * 1000

function buildCurationText(messages: NormalizedTranscript['messages']): string {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => `## ${message.role}\n${message.text}`)
    .filter((block) => block.trim().length > 8)
    .slice(-200)
    .join('\n\n')
}

/**
 * 后台自动提炼驱动：把 CLI 原生会话（claude/codex/gemini…，经搜索索引发现）纳入
 * 默认提炼，无需用户在对话里点任何按钮。空闲 + 提炼纪元之后 + 水位线增量三重收敛，
 * 串行执行、限流、失败退避；与实时对话链路共享 vault 水位线做跨链路去重。
 */
export class MemoryBackgroundCurator {
  private running = false
  private intervalTimer: NodeJS.Timeout | null = null
  private firstTimer: NodeJS.Timeout | null = null
  private readonly failures = new Map<string, number>()

  constructor(
    private readonly worker: MemoryWorkerClient,
    private readonly curation: MemoryCurationService,
    private readonly vault: MemoryVault
  ) {}

  start(): void {
    if (this.intervalTimer) return
    this.intervalTimer = setInterval(() => void this.tick(), TICK_MS)
    this.intervalTimer.unref()
    this.firstTimer = setTimeout(() => void this.tick(), FIRST_TICK_DELAY_MS)
    this.firstTimer.unref()
  }

  /** 索引一轮 reconcile 结束后可调用以加速首轮（可选）。 */
  kick(): void {
    void this.tick()
  }

  close(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    if (this.firstTimer) clearTimeout(this.firstTimer)
    this.intervalTimer = null
    this.firstTimer = null
  }

  private async tick(): Promise<void> {
    if (this.running) return
    const settings = this.vault.getSettings()
    if (!settings.enabled || !settings.generateMemories || !settings.curationEpoch) return
    // 每日预算已满时不再拉取候选或启动 CLI，次日本地自然日自动恢复。
    if (!this.vault.canDepositToday()) return
    // 没有可用 curator 时直接跳过，避免每轮都拉候选又全部失败。
    if (!this.curation.resolveCurator(settings.curatorAgentId?.trim() || undefined)) return

    this.running = true
    try {
      const nowMs = Date.now()
      const candidates = await this.worker.listCurationCandidates({
        idleBeforeIso: new Date(nowMs - IDLE_MS).toISOString(),
        sinceIso: settings.curationEpoch,
        limit: CANDIDATE_LIMIT
      })
      let processed = 0
      for (const candidate of candidates) {
        if (processed >= BATCH_PER_TICK) break
        if (!candidate.cwd || !this.shouldCurate(candidate, nowMs)) continue
        await this.curateOne(candidate)
        processed += 1
      }
    } catch {
      // 后台增强能力：失败不影响应用、索引或实时对话。
    } finally {
      this.running = false
    }
  }

  private shouldCurate(candidate: CurationCandidate, nowMs: number): boolean {
    if ((this.failures.get(candidate.sessionId) ?? 0) >= MAX_FAILURES) return false
    const watermark = this.vault.getCurationWatermark(candidate.sessionId)
    if (!watermark) return true
    if (nowMs - Date.parse(watermark.lastCuratedAt) < COOLDOWN_MS) return false
    const previous = watermark.messageCount ?? 0
    return candidate.messageCount >= previous + MIN_NEW_MESSAGES
  }

  private async curateOne(candidate: CurationCandidate): Promise<void> {
    try {
      const transcript = await this.worker.getTranscript(candidate.sessionId)
      const text = transcript ? buildCurationText(transcript.messages) : ''
      if (!text) {
        // 无可提炼正文（纯工具/系统会话）：打水位线避免反复回看。
        this.vault.recordCuration(candidate.sessionId, candidate.messageCount)
        this.failures.delete(candidate.sessionId)
        return
      }
      await this.curation.curate({
        sourceId: candidate.sessionId,
        cwd: candidate.cwd!,
        text,
        messageCount: candidate.messageCount
      })
      this.failures.delete(candidate.sessionId)
    } catch {
      this.failures.set(candidate.sessionId, (this.failures.get(candidate.sessionId) ?? 0) + 1)
    }
  }
}
