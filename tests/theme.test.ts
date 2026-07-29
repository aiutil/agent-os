import { describe, expect, it } from 'vitest'
import { resolveTheme } from '../src/renderer/src/lib/theme'

describe('resolveTheme (SPEC-010 v2 外观)', () => {
  it('honors explicit light/dark regardless of system', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
  })

  it('follows the system preference when set to system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})
