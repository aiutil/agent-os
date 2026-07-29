import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('SPEC-042 左侧导航可用性', () => {
  it('按项目所有者决定保持紧凑尺寸与无障碍当前态', () => {
    const css = readFileSync('src/renderer/src/v3/v3.css', 'utf8')
    const shell = readFileSync('src/renderer/src/v3/Shell.tsx', 'utf8')
    const railButton = /\.rail-btn\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
    const railIcon = /\.rail-btn svg\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? ''

    expect(css).toMatch(/\.icon-rail\s*\{[\s\S]*?width:\s*44px/)
    expect(railButton).toMatch(/width:\s*32px/)
    expect(railButton).toMatch(/height:\s*32px/)
    expect(railIcon).toMatch(/width:\s*18px/)
    expect(railIcon).toMatch(/height:\s*18px/)
    expect(shell).toContain('aria-label={label}')
    expect(shell).toContain("aria-current={active ? 'page' : undefined}")
  })
})
