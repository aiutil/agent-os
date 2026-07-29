import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  sanitizeCrashText,
  shouldReportProcessGone,
  writeCrashReport
} from '../src/main/crash-reporting'

describe('崩溃诊断', () => {
  it('忽略正常退出或主动终止的子进程', () => {
    expect(shouldReportProcessGone('clean-exit')).toBe(false)
    expect(shouldReportProcessGone('killed')).toBe(false)
    expect(shouldReportProcessGone('crashed')).toBe(true)
    expect(shouldReportProcessGone('oom')).toBe(true)
  })

  it('脱敏常见凭据并限制日志长度', () => {
    const text = sanitizeCrashText(
      `Bearer abc.def token=super-secret app_secret: top-secret ${'x'.repeat(40_000)}`
    )
    expect(text).toContain('Bearer [REDACTED]')
    expect(text).toContain('token=[REDACTED]')
    expect(text).toContain('app_secret: [REDACTED]')
    expect(text).not.toContain('super-secret')
    expect(text.length).toBeLessThanOrEqual(32_000)
  })

  it('以 0600 写入可供用户手动发送的本地日志', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-crash-'))
    const file = writeCrashReport(directory, {
      kind: 'renderer-process-gone',
      detail: 'reason=crashed token=private',
      version: '0.3.0',
      platform: 'win32-x64',
      occurredAt: new Date('2026-07-22T00:00:00Z')
    })
    expect(readFileSync(file, 'utf8')).toContain('kind: renderer-process-gone')
    expect(readFileSync(file, 'utf8')).not.toContain('token=private')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
