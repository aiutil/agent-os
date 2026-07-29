import mixpanel from 'mixpanel-browser'
import type { AnalyticsConfig, AnalyticsEvent, AnalyticsEventEnvelope } from '@shared/types'
import { mixpanelPrivacyConfig } from '@shared/analytics/mixpanel-privacy'

let initialized = false
let sdkInitialized = false
let subscribed = false
let appOpenedTracked = false
const seenEnvelopeIds = new Set<string>()

function track(event: AnalyticsEvent): void {
  if (!initialized) return
  mixpanel.track(event.name, { ...event.properties })
}

function consume(envelope: AnalyticsEventEnvelope): void {
  // 启用/重置期间主进程会同时推送并缓存事件；SDK 未 ready 时不要提前去重，
  // 稍后的 drain 才是这批事件的可靠交付点。
  if (!initialized || seenEnvelopeIds.has(envelope.id)) return
  seenEnvelopeIds.add(envelope.id)
  if (seenEnvelopeIds.size > 500) {
    const oldest = seenEnvelopeIds.values().next().value
    if (oldest) seenEnvelopeIds.delete(oldest)
  }
  track(envelope.event)
}

function registerCommonProperties(config: AnalyticsConfig): void {
  mixpanel.identify(config.installId)
  mixpanel.register({
    app_version: config.appVersion,
    platform: config.platform,
    arch: config.arch,
    environment: config.environment,
    locale: navigator.language.toLowerCase()
  })
}

async function initializeFromConfig(config: AnalyticsConfig): Promise<boolean> {
  if (!config.enabled || !config.token) return false
  try {
    const resumingExistingSdk = sdkInitialized
    if (!sdkInitialized) {
      mixpanel.init(config.token, mixpanelPrivacyConfig())
      sdkInitialized = true
    }
    // 主进程的持久化开关是单一事实源；重新启用时清除 SDK 的本地 opt-out 标记，
    // 且不额外发送 Mixpanel 内建的 $opt_in 事件。
    mixpanel.opt_in_tracking({ track: () => undefined })
    registerCommonProperties(config)
    // opt_in_tracking 只恢复持久化和批量发送，不会恢复曾由 opt-out 停止的回放。
    if (resumingExistingSdk) mixpanel.start_session_recording()
    initialized = true

    if (!subscribed) {
      window.agentOs.events.onAnalyticsEvent(consume)
      subscribed = true
    }
    for (const envelope of await window.agentOs.app.drainAnalyticsEvents()) consume(envelope)
    return true
  } catch (error) {
    initialized = false
    console.warn('[analytics] Mixpanel 初始化失败，当前会话停止分析：', error)
    return false
  }
}

export async function initializeAnalytics(): Promise<boolean> {
  try {
    const enabled = await initializeFromConfig(await window.agentOs.app.getAnalyticsConfig())
    if (enabled && !appOpenedTracked) {
      const platform = await window.agentOs.app.getPlatformInfo()
      mixpanel.track('app_opened', {
        launch_source: 'direct',
        onboarding_state: platform.onboardingCompleted ? 'completed' : 'pending'
      })
      appOpenedTracked = true
    }
    return enabled
  } catch (error) {
    console.warn('[analytics] 无法读取分析配置：', error)
    return false
  }
}

export async function updateAnalyticsTracking(enabled: boolean): Promise<boolean> {
  if (!enabled) {
    if (initialized) {
      mixpanel.track(
        'analytics_consent_updated',
        { consent_state: 'denied', consent_source: 'settings' },
        { send_immediately: true }
      )
    }
    await window.agentOs.app.setAnalyticsEnabled(false)
    if (initialized) {
      mixpanel.stop_session_recording()
      // SDK 默认 clear_persistence=true；显式避免 people API（本项目不创建 User Profile）。
      mixpanel.opt_out_tracking({ delete_user: false })
    }
    initialized = false
    seenEnvelopeIds.clear()
    return false
  }
  const config = await window.agentOs.app.setAnalyticsEnabled(true)
  const initializedNow = await initializeFromConfig(config)
  if (initializedNow) {
    mixpanel.track('analytics_consent_updated', {
      consent_state: 'granted',
      consent_source: 'settings'
    })
  }
  return initializedNow
}

export async function resetAnalyticsIdentity(): Promise<void> {
  const wasInitialized = initialized
  let mainPaused = false
  try {
    // IPC handler 会同步轮换 identity 并 pause 主进程队列。等待期间继续用旧 identity
    // 消费事件；pause 后的同批 envelope 会进入队列，并由既有 seen id 在 drain 时去重。
    const config = await window.agentOs.app.resetAnalyticsIdentity()
    mainPaused = true
    initialized = false
    if (!config.enabled) return
    if (!sdkInitialized) {
      await initializeFromConfig(config)
      return
    }
    mixpanel.reset()
    registerCommonProperties(config)
    mixpanel.start_session_recording()
    initialized = true
    for (const envelope of await window.agentOs.app.drainAnalyticsEvents()) consume(envelope)
  } catch (error) {
    // IPC 本身失败时主进程尚未 pause，可继续旧会话；SDK 重置阶段失败时则保持
    // 停止消费，让主进程队列留待下次初始化，避免 reload 后重复发送。
    initialized = mainPaused ? false : wasInitialized
    console.warn('[analytics] 重置匿名分析标识失败：', error)
  }
}

function countBucket(count: number): string {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 3) return '2_to_3'
  if (count <= 6) return '4_to_6'
  return '7_plus'
}

export function trackOnboardingCompleted(availableCliCount: number): void {
  if (!initialized) return
  mixpanel.track('onboarding_completed', {
    step_count: 6,
    available_cli_count_bucket: countBucket(availableCliCount)
  })
}
