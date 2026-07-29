import type {
  AgentTask,
  AnalyticsEvent,
  CreateSessionInput,
  CreateTaskInput,
  RemoteNodeStatus,
  TaskChangedEvent
} from '@shared/types'

export function analyticsCountBucket(count: number): string {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 3) return '2_to_3'
  if (count <= 6) return '4_to_6'
  return '7_plus'
}

export function analyticsDurationBucket(
  milliseconds: number
): 'under_10s' | '10s_to_30s' | '30s_to_2m' | '2m_to_10m' | 'over_10m' {
  if (milliseconds < 10_000) return 'under_10s'
  if (milliseconds < 30_000) return '10s_to_30s'
  if (milliseconds < 120_000) return '30s_to_2m'
  if (milliseconds < 600_000) return '2m_to_10m'
  return 'over_10m'
}

export function analyticsToolId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : undefined
}

export function sessionCreatedAnalyticsEvent(input: CreateSessionInput): AnalyticsEvent {
  const toolId = analyticsToolId(input.toolId)
  const permissionPreset =
    input.permissionPreset === 'acceptEdits' ? 'accept_edits' : (input.permissionPreset ?? 'safe')
  const creationSource =
    input.source === 'channel'
      ? 'channel'
      : input.source === 'task'
        ? 'scheduled_task'
        : input.relaySource
          ? 'relay'
          : 'user'
  return {
    name: 'agent_session_created',
    properties: {
      surface: input.surface ?? 'terminal',
      runtime_location: input.runtimeHostId && input.runtimeHostId !== 'local' ? 'remote' : 'local',
      permission_preset: permissionPreset,
      creation_source: creationSource,
      ...(toolId ? { tool_id: toolId } : {})
    }
  }
}

export function taskCreatedAnalyticsEvent(input: CreateTaskInput, task: AgentTask): AnalyticsEvent {
  const toolId = analyticsToolId(task.assignee.toolId)
  return {
    name: 'scheduled_task_created',
    properties: {
      creation_source: input.creationSource ?? 'manual',
      schedule_kind: task.schedule?.kind ?? 'manual',
      runtime_location: task.runtimeHostId && task.runtimeHostId !== 'local' ? 'remote' : 'local',
      ...(toolId ? { tool_id: toolId } : {})
    }
  }
}

export function taskRunCompletedAnalyticsEvent(event: TaskChangedEvent): AnalyticsEvent | null {
  if (!event.run || !['run-finished', 'run-skipped'].includes(event.reason)) return null
  const toolId = analyticsToolId(event.task.assignee.toolId)
  const outcome =
    event.run.status === 'succeeded'
      ? 'success'
      : event.run.status === 'interrupted'
        ? 'interrupted'
        : event.run.status === 'skipped'
          ? 'skipped'
          : 'failed'
  const startedAt = event.run.startedAt ? Date.parse(event.run.startedAt) : Number.NaN
  const finishedAt = event.run.finishedAt ? Date.parse(event.run.finishedAt) : Number.NaN
  const duration =
    Number.isFinite(startedAt) && Number.isFinite(finishedAt)
      ? analyticsDurationBucket(Math.max(0, finishedAt - startedAt))
      : undefined
  return {
    name: 'scheduled_task_run_completed',
    properties: {
      outcome,
      trigger: event.run.trigger,
      runtime_location:
        event.task.runtimeHostId && event.task.runtimeHostId !== 'local' ? 'remote' : 'local',
      ...(duration ? { duration_bucket: duration } : {}),
      ...(toolId ? { tool_id: toolId } : {})
    }
  }
}

export function remoteConnectedAnalyticsEvent(
  status: RemoteNodeStatus,
  connectionMethod: 'legacy' | 'managed_pairing'
): AnalyticsEvent {
  return {
    name: 'remote_node_connected',
    properties: {
      connection_method: connectionMethod,
      node_platform: status.platform ?? 'unknown',
      agent_count_bucket: analyticsCountBucket(status.agents?.length ?? 0)
    }
  }
}
