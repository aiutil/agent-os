import { app, BrowserWindow, dialog, shell } from 'electron'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const AUTHOR_EMAIL = 'days365le@gmail.com'
type CrashKind =
  | 'main-uncaught-exception'
  | 'main-unhandled-rejection'
  | 'renderer-process-gone'
  | 'child-process-gone'

export function shouldReportProcessGone(reason: string): boolean {
  return !['clean-exit', 'killed'].includes(reason)
}

export function sanitizeCrashText(value: unknown): string {
  const raw =
    value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ''}` : String(value)
  return raw
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(
      /((?:token|secret|password|credential|app_secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]'
    )
    .slice(0, 32_000)
}

export function writeCrashReport(
  directory: string,
  input: { kind: string; detail: unknown; version: string; platform: string; occurredAt?: Date }
): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const occurredAt = input.occurredAt ?? new Date()
  const file = join(directory, `crash-${occurredAt.toISOString().replace(/[:.]/g, '-')}.log`)
  const content = [
    'Agent OS crash report',
    `occurredAt: ${occurredAt.toISOString()}`,
    `kind: ${input.kind}`,
    `version: ${input.version}`,
    `platform: ${input.platform}`,
    '',
    sanitizeCrashText(input.detail),
    ''
  ].join('\n')
  writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

export function installCrashReporting(
  getMainWindow: () => BrowserWindow | null,
  onCrashRecorded?: (signal: {
    crashKind: CrashKind
    processType: 'main' | 'renderer' | 'child'
    appVersion: string
  }) => void
): () => void {
  let prompting = false
  let installed = true

  const report = async (kind: CrashKind, detail: unknown, fatal: boolean): Promise<void> => {
    if (!installed) return
    let reportPath = ''
    try {
      reportPath = writeCrashReport(join(app.getPath('userData'), 'crash-reports'), {
        kind,
        detail,
        version: app.getVersion(),
        platform: `${process.platform}-${process.arch}`
      })
      onCrashRecorded?.({
        crashKind: kind,
        processType: kind.startsWith('renderer-')
          ? 'renderer'
          : kind.startsWith('child-')
            ? 'child'
            : 'main',
        appVersion: app.getVersion()
      })
    } catch (error) {
      console.error('[crash-report] 写入失败：', sanitizeCrashText(error))
    }
    if (prompting) return
    prompting = true
    try {
      const options = {
        type: 'error' as const,
        title: 'Agent OS 遇到错误',
        message: 'Agent OS 发生异常，已在本机生成脱敏诊断日志。',
        detail: reportPath
          ? `你可以联系作者并手动附上日志：\n${reportPath}`
          : '诊断日志写入失败，你仍可以联系作者说明复现步骤。',
        buttons: ['联系作者', '打开日志目录', '重启 Agent OS', fatal ? '退出' : '稍后处理'],
        defaultId: 0,
        cancelId: 3,
        noLink: true
      }
      const owner = getMainWindow()
      const result =
        owner && !owner.isDestroyed()
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options)
      if (result.response === 0) {
        const subject = encodeURIComponent(`Agent OS ${app.getVersion()} 崩溃日志`)
        const body = encodeURIComponent(
          `你好，Agent OS 发生异常。\n\n类型：${kind}\n日志路径：${reportPath || '写入失败'}\n\n请在发送前手动附上日志文件，并补充复现步骤。`
        )
        await shell.openExternal(`mailto:${AUTHOR_EMAIL}?subject=${subject}&body=${body}`)
      } else if (result.response === 1 && reportPath) {
        shell.showItemInFolder(reportPath)
      } else if (result.response === 2) {
        app.relaunch()
        app.exit(1)
      } else if (fatal) {
        app.exit(1)
      }
    } catch (error) {
      console.error('[crash-report] 弹窗失败：', sanitizeCrashText(error))
      if (fatal) app.exit(1)
    } finally {
      prompting = false
    }
  }

  const onException = (error: Error): void => {
    void report('main-uncaught-exception', error, true)
  }
  const onRejection = (reason: unknown): void => {
    void report('main-unhandled-rejection', reason, false)
  }
  const onRendererGone = (
    _event: Electron.Event,
    _webContents: Electron.WebContents,
    details: Electron.RenderProcessGoneDetails
  ): void => {
    if (!shouldReportProcessGone(details.reason)) return
    void report('renderer-process-gone', JSON.stringify(details, null, 2), false)
  }
  const onChildGone = (_event: Electron.Event, details: Electron.Details): void => {
    if (!shouldReportProcessGone(details.reason)) return
    void report('child-process-gone', JSON.stringify(details, null, 2), false)
  }
  process.on('uncaughtException', onException)
  process.on('unhandledRejection', onRejection)
  app.on('render-process-gone', onRendererGone)
  app.on('child-process-gone', onChildGone)
  return () => {
    installed = false
    process.off('uncaughtException', onException)
    process.off('unhandledRejection', onRejection)
    app.off('render-process-gone', onRendererGone)
    app.off('child-process-gone', onChildGone)
  }
}
