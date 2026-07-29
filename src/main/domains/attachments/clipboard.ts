// 剪贴板文件引用读取（SPEC-038 粘贴「复制的文件」场景）。
// Finder / 资源管理器复制的文件，渲染层 paste 事件只能拿到内容副本（拿不到原磁盘路径）；
// 故由主进程经 electron.clipboard（macOS）/ PowerShell（Windows）取真实绝对路径，
// 作为附件路径直传 CLI（与 selectFile 一致，不拷贝）。

import { clipboard } from 'electron'
import { execFile } from 'node:child_process'

/** 把 file:// URL 解析成本地路径；非 file URL 或非法返回 null。 */
export function fileUrlToPath(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'file:') return null
    return decodeURIComponent(u.pathname)
  } catch {
    return null
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

/** 从 NSFilenamesPboardType plist 里提取绝对路径字符串列表（多文件场景）。 */
export function extractPlistPaths(plist: string): string[] {
  return [...plist.matchAll(/<string>(.*?)<\/string>/g)]
    .map((m) => decodeXmlEntities(m[1]))
    .filter((s) => s.startsWith('/'))
}

function readMacClipboardFiles(): string[] {
  // 多文件：NSFilenamesPboardType（plist 数组；UTI 虽 deprecated，Finder 复制多文件仍会写）。
  const plist = clipboard.read('NSFilenamesPboardType')
  if (plist) {
    const paths = extractPlistPaths(plist)
    if (paths.length) return paths
  }
  // 单文件兜底：public.file-url（file:// URL 或裸绝对路径）。
  const raw = clipboard.read('public.file-url')
  if (raw) {
    const p = raw.startsWith('/') ? decodeURIComponent(raw) : fileUrlToPath(raw)
    if (p) return [p]
  }
  return []
}

function readWindowsClipboardFiles(): Promise<string[]> {
  // Electron 不原生读 CF_HDROP；借 PowerShell Get-Clipboard -Format FileDropList。
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'
      ],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([])
        resolve(
          stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        )
      }
    )
  })
}

/**
 * 读剪贴板里「文件引用」的绝对路径数组。
 * 无文件引用（纯文本 / 截图图片内容 / Linux）返回 []——前端据此回落到图片 stage。
 */
export async function readClipboardFilePaths(): Promise<string[]> {
  if (process.platform === 'darwin') return readMacClipboardFiles()
  if (process.platform === 'win32') return readWindowsClipboardFiles()
  return []
}
