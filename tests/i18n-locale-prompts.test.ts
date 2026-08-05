import { describe, expect, it } from 'vitest'
import {
  defaultCurationPrompt,
  DEFAULT_KNOWLEDGE_CURATION_PROMPTS,
  DEFAULT_MEMORY_CURATION_PROMPTS,
  isBundledCurationPrompt
} from '../src/shared/curation-prompts'
import { langFromLocale, resolveLang } from '../src/shared/i18n'

describe('SPEC-047 locale and curation prompt resolution', () => {
  it('maps Chinese locale variants to zh and every other locale to en', () => {
    expect(langFromLocale('zh-CN')).toBe('zh')
    expect(langFromLocale('zh-Hant-HK')).toBe('zh')
    expect(langFromLocale('en-US')).toBe('en')
    expect(langFromLocale('ja-JP')).toBe('en')
    expect(langFromLocale(undefined)).toBe('en')
  })

  it('uses system language only while the preference follows the system', () => {
    expect(resolveLang('system', 'en')).toBe('en')
    expect(resolveLang('zh', 'en')).toBe('zh')
    expect(resolveLang('en', 'zh')).toBe('en')
  })

  it('provides distinct bilingual defaults and recognizes both as bundled', () => {
    expect(defaultCurationPrompt('memory', 'zh')).toBe(DEFAULT_MEMORY_CURATION_PROMPTS.zh)
    expect(defaultCurationPrompt('memory', 'en')).toBe(DEFAULT_MEMORY_CURATION_PROMPTS.en)
    expect(defaultCurationPrompt('knowledge', 'zh')).toBe(DEFAULT_KNOWLEDGE_CURATION_PROMPTS.zh)
    expect(defaultCurationPrompt('knowledge', 'en')).toBe(DEFAULT_KNOWLEDGE_CURATION_PROMPTS.en)
    expect(DEFAULT_MEMORY_CURATION_PROMPTS.zh).not.toBe(DEFAULT_MEMORY_CURATION_PROMPTS.en)
    expect(isBundledCurationPrompt('knowledge', DEFAULT_KNOWLEDGE_CURATION_PROMPTS.en)).toBe(true)
    expect(isBundledCurationPrompt('knowledge', 'My private writing policy')).toBe(false)
  })
})
