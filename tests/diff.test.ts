import { describe, expect, it } from 'vitest'
import { isUnifiedDiff, parseDiff, diffStats } from '../src/renderer/src/lib/markdown/diff'

const SAMPLE = [
  '@@ -1,3 +1,4 @@',
  ' import React from "react"',
  '-const a = 1',
  '+const a = 2',
  '+const b = 3'
].join('\n')

describe('unified diff parsing (SPEC-005 v2)', () => {
  it('detects a unified diff via hunk header', () => {
    expect(isUnifiedDiff(SAMPLE)).toBe(true)
    expect(isUnifiedDiff('just some text')).toBe(false)
  })

  it('classifies each line', () => {
    const lines = parseDiff(SAMPLE)
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'context', 'del', 'add', 'add'])
  })

  it('counts added/deleted lines', () => {
    expect(diffStats(parseDiff(SAMPLE))).toEqual({ added: 2, deleted: 1 })
  })
})
