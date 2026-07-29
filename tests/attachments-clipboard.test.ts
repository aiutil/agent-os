// SPEC-038 剪贴板路径解析纯函数单测（不触 electron.clipboard）。
import { describe, expect, it } from 'vitest'
import { extractPlistPaths, fileUrlToPath } from '../src/main/domains/attachments/clipboard'

describe('clipboard path helpers (SPEC-038)', () => {
  it('fileUrlToPath 解析 file:// URL（含 percent-encoding）', () => {
    expect(fileUrlToPath('file:///Users/tester/x.png')).toBe('/Users/tester/x.png')
    expect(fileUrlToPath('file:///Users/a%20b/x%26y.txt')).toBe('/Users/a b/x&y.txt')
    expect(fileUrlToPath('https://host/y')).toBeNull()
    expect(fileUrlToPath('not a url')).toBeNull()
  })

  it('extractPlistPaths 从 NSFilenamesPboardType plist 提取绝对路径并解码实体', () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><array>
<string>/Users/a/x.png</string>
<string>/Users/b/y.txt &amp; z</string>
</array></plist>`
    expect(extractPlistPaths(plist)).toEqual(['/Users/a/x.png', '/Users/b/y.txt & z'])
  })

  it('extractPlistPaths 过滤非绝对路径', () => {
    expect(extractPlistPaths('<string>relative/path</string><string>/abs/file</string>')).toEqual([
      '/abs/file'
    ])
  })

  it('extractPlistPaths 空串返回空数组', () => {
    expect(extractPlistPaths('')).toEqual([])
  })
})
