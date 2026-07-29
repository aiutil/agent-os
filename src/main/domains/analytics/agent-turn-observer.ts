import type { AnalyticsEvent, HostEvent, WorkbenchSession } from '@shared/types'
import { analyticsDurationBucket, analyticsToolId } from './events'

interface TurnObservation {
  startedAt: number
  hadToolCalls: boolean
}

export interface AgentTurnAnalyticsDeps {
  now?(): number
  getSession(sessionId: string): WorkbenchSession | null
  publish(event: AnalyticsEvent): void
}

/** 将 Runtime 事件压缩为已签字的 Value Moment 白名单，不转发任何事件原文。 */
export class AgentTurnAnalyticsObserver {
  private readonly turns = new Map<string, TurnObservation>()
  private readonly completedTurnIds = new Set<string>()
  private readonly now: () => number

  constructor(private readonly deps: AgentTurnAnalyticsDeps) {
    this.now = deps.now ?? Date.now
  }

  observe(event: HostEvent): void {
    if (event.kind !== 'agent-event') return
    const key = `${event.sessionId}:${event.turnId ?? 'current'}`
    let observation = this.turns.get(key)
    if (!observation) {
      observation = { startedAt: this.now(), hadToolCalls: false }
      this.turns.set(key, observation)
      this.prune()
    }
    if (event.event.kind === 'tool-start') observation.hadToolCalls = true
    if (event.event.kind !== 'turn-end') return

    this.turns.delete(key)
    if (event.turnId) {
      if (this.completedTurnIds.has(key)) return
      this.completedTurnIds.add(key)
      if (this.completedTurnIds.size > 500) {
        const oldest = this.completedTurnIds.values().next().value
        if (oldest) this.completedTurnIds.delete(oldest)
      }
    }

    const session = this.deps.getSession(event.sessionId)
    const toolId = analyticsToolId(session?.toolId)
    this.deps.publish({
      name: 'agent_turn_completed',
      properties: {
        outcome: event.event.status === 'completed' ? 'success' : 'interrupted',
        surface: session?.source === 'channel' ? 'channel' : (session?.surface ?? 'chat'),
        runtime_location:
          session?.runtimeHostId && session.runtimeHostId !== 'local' ? 'remote' : 'local',
        had_tool_calls: observation.hadToolCalls,
        duration_bucket: analyticsDurationBucket(Math.max(0, this.now() - observation.startedAt)),
        ...(toolId ? { tool_id: toolId } : {})
      }
    })
  }

  clear(): void {
    this.turns.clear()
    this.completedTurnIds.clear()
  }

  private prune(): void {
    while (this.turns.size > 500) {
      const oldest = this.turns.keys().next().value
      if (!oldest) return
      this.turns.delete(oldest)
    }
  }
}
