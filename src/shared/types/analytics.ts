export type AnalyticsEnvironment = 'development' | 'production'

/** Renderer 初始化 Mixpanel 所需的最小配置。Project token 是公开标识，不是凭据。 */
export interface AnalyticsConfig {
  enabled: boolean
  /** 用户持久化开关；与 token 是否可用分开，供设置页准确展示。 */
  trackingEnabled: boolean
  environment: AnalyticsEnvironment
  token: string
  installId: string
  appVersion: string
  platform: NodeJS.Platform
  arch: string
  disabledReason?: 'user_opted_out' | 'missing_development_token' | 'missing_production_token'
}

export interface AgentTurnCompletedAnalyticsProperties {
  outcome: 'success' | 'interrupted'
  surface: 'chat' | 'terminal' | 'channel'
  runtime_location: 'local' | 'remote'
  had_tool_calls: boolean
  tool_id?: string
  duration_bucket?: 'under_10s' | '10s_to_30s' | '30s_to_2m' | '2m_to_10m' | 'over_10m'
}

type DurationBucket = NonNullable<AgentTurnCompletedAnalyticsProperties['duration_bucket']>
type RuntimeLocation = 'local' | 'remote'

export type AnalyticsEvent =
  | { name: 'agent_turn_completed'; properties: AgentTurnCompletedAnalyticsProperties }
  | {
      name: 'app_opened'
      properties: {
        launch_source: 'direct'
        onboarding_state: 'pending' | 'completed'
      }
    }
  | {
      name: 'agent_session_created'
      properties: {
        surface: 'chat' | 'terminal'
        runtime_location: RuntimeLocation
        permission_preset: 'safe' | 'accept_edits' | 'auto'
        creation_source: 'user' | 'channel' | 'scheduled_task' | 'relay'
        tool_id?: string
      }
    }
  | {
      name: 'scheduled_task_created'
      properties: {
        creation_source: 'manual' | 'semantic'
        schedule_kind: 'manual' | 'once' | 'interval' | 'cron'
        runtime_location: RuntimeLocation
        tool_id?: string
      }
    }
  | {
      name: 'scheduled_task_run_completed'
      properties: {
        outcome: 'success' | 'failed' | 'interrupted' | 'skipped'
        trigger: 'manual' | 'schedule'
        runtime_location: RuntimeLocation
        duration_bucket?: DurationBucket
        tool_id?: string
      }
    }
  | {
      name: 'remote_node_connected'
      properties: {
        connection_method: 'legacy' | 'managed_pairing'
        node_platform: string
        agent_count_bucket: string
      }
    }
  | {
      name: 'message_channel_connected'
      properties: {
        channel_platform: string
        connection_method: 'websocket' | 'polling' | 'qr' | 'webhook'
        account_count_bucket: string
      }
    }
  | {
      name: 'update_installed'
      properties: { from_version: string; to_version: string; platform: string }
    }
  | {
      name: 'app_crashed'
      properties: {
        crash_kind: string
        process_type: 'main' | 'renderer' | 'child'
        app_version: string
      }
    }
  | {
      name: 'analytics_consent_updated'
      properties: { consent_state: 'granted' | 'denied'; consent_source: 'settings' }
    }

/** 仅用于主进程→renderer 的可靠投递与去重；id 不会发送到 Mixpanel。 */
export interface AnalyticsEventEnvelope {
  id: string
  event: AnalyticsEvent
}
