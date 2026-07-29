import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentTurnAnalyticsObserver } from '../src/main/domains/analytics/agent-turn-observer'
import { buildAnalyticsConfig } from '../src/main/domains/analytics/config'
import { AnalyticsEventBus } from '../src/main/domains/analytics/event-bus'
import {
  sessionCreatedAnalyticsEvent,
  taskCreatedAnalyticsEvent,
  taskRunCompletedAnalyticsEvent
} from '../src/main/domains/analytics/events'
import {
  consumePendingCrashSignal,
  recordVersionUpgrade,
  writePendingCrashSignal
} from '../src/main/domains/analytics/lifecycle-signals'
import { PACKAGED_RENDERER_URL, resolveRendererAssetPath } from '../src/main/renderer-asset-path'
import {
  ANALYTICS_PROPERTY_BLACKLIST,
  mixpanelPrivacyConfig
} from '../src/shared/analytics/mixpanel-privacy'
import type { AnalyticsEvent, HostEvent, WorkbenchSession } from '../src/shared/types'

const session = {
  id: 'session-sensitive-id',
  name: '包含用户 prompt 的标题',
  toolId: 'Codex',
  workspacePath: '/Users/private/project',
  terminalSessionId: null,
  nativeSessionId: null,
  surface: 'chat',
  permissionPreset: 'safe',
  favorite: false,
  pinned: false,
  runtimeHostId: 'remote-private-host'
} as WorkbenchSession

describe('Mixpanel Full analytics', () => {
  it('打包 renderer 使用稳定协议地址且拒绝越出资源目录', () => {
    const rendererRoot = '/Applications/Agent OS.app/Contents/Resources/app.asar/out/renderer'
    expect(PACKAGED_RENDERER_URL).toBe('agent-os://app/index.html')
    expect(PACKAGED_RENDERER_URL).not.toContain(rendererRoot)
    expect(resolveRendererAssetPath(rendererRoot, PACKAGED_RENDERER_URL)).toBe(
      `${rendererRoot}/index.html`
    )
    expect(
      resolveRendererAssetPath(rendererRoot, 'agent-os://app/%2F..%2F..%2Fprivate.txt')
    ).toBeNull()
    expect(resolveRendererAssetPath(rendererRoot, 'agent-os://evil/index.html')).toBeNull()
  })

  it('开发 token 缺失时硬关闭，打包生产只使用 production token', () => {
    const base = {
      trackingEnabled: true,
      productionToken: 'prod-token',
      developmentToken: '',
      installId: 'install-id',
      appVersion: '0.3.0',
      platform: 'darwin' as const,
      arch: 'arm64'
    }
    expect(buildAnalyticsConfig({ ...base, isPackaged: false })).toMatchObject({
      enabled: false,
      environment: 'development',
      token: '',
      disabledReason: 'missing_development_token'
    })
    expect(buildAnalyticsConfig({ ...base, isPackaged: true })).toMatchObject({
      enabled: true,
      trackingEnabled: true,
      environment: 'production',
      token: 'prod-token'
    })
    expect(
      buildAnalyticsConfig({ ...base, isPackaged: true, trackingEnabled: false })
    ).toMatchObject({
      enabled: false,
      trackingEnabled: false,
      disabledReason: 'user_opted_out'
    })
  })

  it('Autocapture 与 100% Replay 默认遮罩并禁止敏感内容通道', () => {
    const config = mixpanelPrivacyConfig()
    expect(config.autocapture as object).toMatchObject({
      pageview: false,
      input: false,
      capture_text_content: false
    })
    expect(config).toMatchObject({
      record_sessions_percent: 100,
      record_mask_all_text: true,
      record_mask_all_inputs: true,
      record_console: false,
      record_network: false,
      record_canvas: false,
      ip: false
    })
    expect(String(config.record_block_selector)).toContain('.chat-view')
    expect(String(config.record_block_selector)).toContain('.terminal-view')
    expect(String(config.record_block_selector)).toContain('.settings-modal')
    expect(config.property_blacklist).toEqual(ANALYTICS_PROPERTY_BLACKLIST)
    expect(config.property_blacklist).toContain('$current_url')
    expect(config).toMatchObject({ save_referrer: false, store_google: false })
  })

  it('Value Moment 仅产生 tracking plan 白名单属性并按 turnId 去重', () => {
    let now = 1_000
    const published: AnalyticsEvent[] = []
    const observer = new AgentTurnAnalyticsObserver({
      now: () => now,
      getSession: () => session,
      publish: (event) => published.push(event)
    })
    const base = { kind: 'agent-event', sessionId: session.id, turnId: 'turn-secret-id' } as const
    observer.observe({
      ...base,
      event: {
        kind: 'tool-start',
        toolUseId: 'tool-secret',
        toolName: 'Read',
        input: { prompt: 'secret' }
      }
    })
    now = 45_000
    const terminal: HostEvent = {
      ...base,
      event: { kind: 'turn-end', status: 'completed', costUsd: 9.99 }
    }
    observer.observe(terminal)
    observer.observe(terminal)

    expect(published).toEqual([
      {
        name: 'agent_turn_completed',
        properties: {
          outcome: 'success',
          surface: 'chat',
          runtime_location: 'remote',
          had_tool_calls: true,
          duration_bucket: '30s_to_2m',
          tool_id: 'codex'
        }
      }
    ])
    const serialized = JSON.stringify(published)
    for (const forbidden of [
      'session-sensitive-id',
      'turn-secret-id',
      'tool-secret',
      'secret',
      '/Users/private/project',
      '包含用户 prompt 的标题',
      '9.99'
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('主进程队列有界且 drain 后清空', () => {
    const emit = vi.fn()
    const bus = new AnalyticsEventBus(emit, 2)
    const event: AnalyticsEvent = {
      name: 'agent_turn_completed',
      properties: {
        outcome: 'success',
        surface: 'chat',
        runtime_location: 'local',
        had_tool_calls: false
      }
    }
    bus.publish(event)
    bus.publish(event)
    bus.publish(event)
    expect(emit).toHaveBeenCalledTimes(3)
    expect(bus.drain()).toHaveLength(2)
    expect(bus.drain()).toEqual([])
    bus.publish(event)
    expect(bus.drain()).toEqual([])
    bus.pause()
    bus.publish(event)
    expect(bus.drain()).toHaveLength(1)
    bus.setEnabled(false)
    bus.publish(event)
    expect(emit).toHaveBeenCalledTimes(5)
    expect(bus.drain()).toEqual([])
    bus.setEnabled(true)
    bus.publish(event)
    expect(bus.drain()).toHaveLength(1)
  })

  it('P1 事件工厂只保留签字白名单，不泄露标题、prompt、路径或 runtime id', () => {
    const sessionEvent = sessionCreatedAnalyticsEvent({
      name: '用户的秘密标题',
      toolId: 'Codex',
      workspacePath: '/Users/private/project',
      surface: 'chat',
      permissionPreset: 'acceptEdits',
      runtimeHostId: 'private-host-id'
    })
    const taskInput = {
      title: '秘密任务',
      prompt: '不要发送这段 prompt',
      workspacePath: '/Users/private/project',
      runtimeHostId: 'private-host-id',
      assignee: { toolId: 'Codex' },
      schedule: {
        kind: 'interval' as const,
        everyMs: 30 * 60_000,
        anchorAt: '2026-07-22T08:00:00.000Z',
        timeZone: 'Asia/Shanghai',
        enabled: true,
        misfirePolicy: 'run_once' as const
      },
      creationSource: 'semantic' as const
    }
    const task = {
      ...taskInput,
      id: 'private-task-id',
      boardStatus: 'todo' as const,
      executionStatus: 'idle' as const,
      permissionPreset: 'safe' as const,
      sessionPolicy: 'new' as const,
      createdAt: '2026-07-22T08:00:00.000Z',
      updatedAt: '2026-07-22T08:00:00.000Z'
    }
    const taskEvent = taskCreatedAnalyticsEvent(taskInput, task)
    const runEvent = taskRunCompletedAnalyticsEvent({
      task,
      reason: 'run-finished',
      run: {
        id: 'private-run-id',
        taskId: task.id,
        trigger: 'schedule',
        status: 'succeeded',
        startedAt: '2026-07-22T08:00:00.000Z',
        finishedAt: '2026-07-22T08:00:45.000Z'
      }
    })
    expect(sessionEvent).toMatchObject({
      name: 'agent_session_created',
      properties: {
        surface: 'chat',
        runtime_location: 'remote',
        permission_preset: 'accept_edits',
        creation_source: 'user',
        tool_id: 'codex'
      }
    })
    expect(taskEvent).toMatchObject({
      name: 'scheduled_task_created',
      properties: {
        creation_source: 'semantic',
        schedule_kind: 'interval',
        runtime_location: 'remote'
      }
    })
    expect(runEvent).toMatchObject({
      name: 'scheduled_task_run_completed',
      properties: { outcome: 'success', duration_bucket: '30s_to_2m' }
    })
    const serialized = JSON.stringify([sessionEvent, taskEvent, runEvent])
    for (const forbidden of [
      '用户的秘密标题',
      '秘密任务',
      '不要发送这段 prompt',
      '/Users/private/project',
      'private-host-id',
      'private-task-id',
      'private-run-id'
    ])
      expect(serialized).not.toContain(forbidden)
  })

  it('P2 崩溃信号与版本升级标记使用 0600 且只消费一次', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-analytics-'))
    const crashFile = join(directory, 'pending-crash.json')
    writePendingCrashSignal(crashFile, {
      crashKind: 'renderer-process-gone',
      processType: 'renderer',
      appVersion: '0.3.0'
    })
    expect(statSync(crashFile).mode & 0o777).toBe(0o600)
    expect(consumePendingCrashSignal(crashFile)).toEqual({
      crashKind: 'renderer-process-gone',
      processType: 'renderer',
      appVersion: '0.3.0'
    })
    expect(consumePendingCrashSignal(crashFile)).toBeNull()

    writeFileSync(crashFile, '{malformed analytics marker', { mode: 0o600 })
    expect(consumePendingCrashSignal(crashFile)).toBeNull()
    expect(existsSync(crashFile)).toBe(false)

    const versionFile = join(directory, 'last-version.json')
    expect(recordVersionUpgrade(versionFile, '0.3.0')).toBeNull()
    expect(recordVersionUpgrade(versionFile, '0.3.0')).toBeNull()
    expect(recordVersionUpgrade(versionFile, '0.4.0')).toEqual({
      fromVersion: '0.3.0',
      toVersion: '0.4.0'
    })
  })
})
