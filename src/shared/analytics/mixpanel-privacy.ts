/**
 * Agent OS 包含 prompt、回复、终端、路径与渠道凭据。Autocapture 只记录交互结构，
 * Session Replay 保留布局/动作但全量遮罩文本与输入，并完全屏蔽高敏区域。
 */
export const ANALYTICS_SENSITIVE_SELECTOR = [
  '.chat-view',
  '.chat-pane',
  '.terminal-view',
  '.settings-modal',
  '.xterm',
  '[data-analytics-sensitive="true"]'
].join(', ')

/** Mixpanel 自动添加的 URL、来源页与设备画像不属于签字后的公共属性白名单。 */
export const ANALYTICS_PROPERTY_BLACKLIST = [
  '$current_url',
  '$referrer',
  '$referring_domain',
  '$initial_referrer',
  '$initial_referring_domain',
  '$os',
  '$browser',
  '$browser_version',
  '$device',
  '$screen_height',
  '$screen_width',
  'current_url_path',
  'current_url_protocol',
  'current_url_search'
]

export interface MixpanelPrivacyConfig {
  autocapture: {
    pageview: boolean
    click: boolean
    dead_click: boolean
    rage_click: boolean
    scroll: boolean
    submit: boolean
    input: boolean
    capture_text_content: boolean
    block_selectors: string[]
    block_attrs: string[]
  }
  record_sessions_percent: number
  record_mask_all_text: boolean
  record_mask_all_inputs: boolean
  record_block_selector: string
  record_console: boolean
  record_network: boolean
  record_canvas: boolean
  ip: boolean
  save_referrer: boolean
  store_google: boolean
  stop_utm_persistence: boolean
  property_blacklist: string[]
  persistence: 'localStorage'
  debug: boolean
}

export function mixpanelPrivacyConfig(): MixpanelPrivacyConfig {
  return {
    autocapture: {
      pageview: false,
      click: true,
      dead_click: true,
      rage_click: true,
      scroll: true,
      submit: true,
      input: false,
      capture_text_content: false,
      block_selectors: [ANALYTICS_SENSITIVE_SELECTOR],
      block_attrs: ['aria-label', 'title', 'name', 'value', 'data-path', 'data-url']
    },
    record_sessions_percent: 100,
    record_mask_all_text: true,
    record_mask_all_inputs: true,
    record_block_selector: `img, video, audio, canvas, iframe, ${ANALYTICS_SENSITIVE_SELECTOR}`,
    record_console: false,
    record_network: false,
    record_canvas: false,
    ip: false,
    save_referrer: false,
    store_google: false,
    stop_utm_persistence: true,
    property_blacklist: [...ANALYTICS_PROPERTY_BLACKLIST],
    persistence: 'localStorage',
    debug: false
  }
}
