import { describe, expect, it } from 'vitest'
import {
  assertFixtureIsSanitized,
  scrubFixtureContent
} from '../src/main/domains/diagnostics/fixture-scrubber'

describe('fixture scrubber', () => {
  it('替换路径、邮箱、密钥、会话身份和自由文本，同时保留格式字段', () => {
    const input = [
      JSON.stringify({
        type: 'user',
        version: '2.1.170',
        sessionId: '06ac5efe-feb4-45c4-ad97-976a52e56982',
        cwd: '/Users/alice/private/project',
        email: 'alice@example.com',
        apiKey: 'sk-test-abcdefghijklmnopqrstuvwxyz',
        message: {
          role: 'user',
          content: 'Deploy secret customer plan from /Users/alice/private/project'
        }
      })
    ].join('\n')

    const output = scrubFixtureContent(input)
    const record = JSON.parse(output)

    expect(record.type).toBe('user')
    expect(record.version).toBe('2.1.170')
    expect(record.sessionId).toBe('00000000-0000-4000-8000-000000000001')
    expect(record.cwd).toBe('/workspace/redacted')
    expect(record.email).toBe('[REDACTED_EMAIL]')
    expect(record.apiKey).toBe('[REDACTED_SECRET]')
    expect(record.message).toEqual({ role: 'user', content: '[REDACTED_TEXT]' })
    expect(() => assertFixtureIsSanitized(output)).not.toThrow()
  })

  it('发现残留敏感数据时拒绝通过', () => {
    expect(() =>
      assertFixtureIsSanitized(
        '{"type":"user","cwd":"/Users/alice/private","token":"ghp_abcdefghijklmnopqrstuvwxyz123456"}'
      )
    ).toThrow(/敏感数据/)
  })
})
