const SENSITIVE_PATTERNS = [
  /\/Users\/[^/"\s]+/i,
  /[A-Z]:\\Users\\[^"\\\s]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
]

const STRUCTURAL_STRING_KEYS = new Set([
  'type',
  'role',
  'version',
  'cli_version',
  'timestamp',
  'entrypoint',
  'subtype',
  'name',
  'model_provider',
  'originator',
  'source',
  'permissionMode',
  'userType'
])

const PATH_KEYS = /^(cwd|path|file_path|workspace|workspacePath|root)$/i
const EMAIL_KEYS = /email/i
const SECRET_KEYS = /(api.?key|token|secret|password|authorization)/i
const ID_KEYS = /(^id$|Id$|_id$|uuid$|Uuid$|call_id$)/i

export function scrubFixtureContent(content: string): string {
  const idMap = new Map<string, string>()
  let nextId = 1

  const scrubId = (value: string): string => {
    const existing = idMap.get(value)
    if (existing) return existing
    const suffix = String(nextId).padStart(12, '0')
    nextId += 1
    const replacement = `00000000-0000-4000-8000-${suffix}`
    idMap.set(value, replacement)
    return replacement
  }

  const scrubValue = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((item) => scrubValue(item))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          scrubValue(childValue, childKey)
        ])
      )
    }
    if (typeof value !== 'string') return value

    if (PATH_KEYS.test(key)) return '/workspace/redacted'
    if (EMAIL_KEYS.test(key)) return '[REDACTED_EMAIL]'
    if (SECRET_KEYS.test(key)) return '[REDACTED_SECRET]'
    if (ID_KEYS.test(key)) return scrubId(value)
    if (STRUCTURAL_STRING_KEYS.has(key)) return value
    return '[REDACTED_TEXT]'
  }

  const lines = content.split(/\r?\n/)
  const scrubbed = lines.map((line) => {
    if (!line.trim()) return ''
    const parsed: unknown = JSON.parse(line)
    return JSON.stringify(scrubValue(parsed))
  })
  const output = scrubbed.join('\n')
  assertFixtureIsSanitized(output)
  return output
}

export function assertFixtureIsSanitized(content: string): void {
  const matched = SENSITIVE_PATTERNS.find((pattern) => pattern.test(content))
  if (matched) {
    throw new Error(`fixture 仍包含敏感数据：${matched.source}`)
  }
}
