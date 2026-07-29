import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listAdapters } from '../src/main/domains/adapters/registry'
import type { NormalizedMessage } from '../src/shared/types/transcript'

interface FixtureExpectation {
  toolId: string
  cliVersion: string
  file: string
  messageCount: number
  roles: NormalizedMessage['role'][]
  title: string
  nativeSessionId: string
  parseErrors: number
}

const FIXTURE_ROOT = resolve('tests', 'fixtures', 'transcripts')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function evaluateFixture(
  expected: FixtureExpectation,
  fixtureDir: string
): Promise<FixtureExpectation> {
  const storage = listAdapters().find((adapter) => adapter.id === expected.toolId)
    ?.sessionStorage
  if (!storage?.parseTranscript || !storage.readMeta) {
    throw new Error(`${expected.toolId} 没有 full transcript 能力`)
  }

  const filePath = join(fixtureDir, expected.file)
  const stream = storage.parseTranscript(filePath)
  const messages: NormalizedMessage[] = []
  for await (const message of stream) messages.push(message)
  const summary = await stream.summary
  const meta = await storage.readMeta(filePath)

  return {
    toolId: expected.toolId,
    cliVersion: expected.cliVersion,
    file: expected.file,
    messageCount: messages.length,
    roles: messages.map((message) => message.role),
    title: meta.title,
    nativeSessionId: meta.nativeSessionId,
    parseErrors: summary.parseErrors
  }
}

describe('transcript fixture contract', () => {
  const fullAdapters = listAdapters().filter(
    (adapter) =>
      adapter.sessionStorage?.support === 'full' &&
      adapter.sessionStorage.parseTranscript &&
      adapter.sessionStorage.readMeta
  )

  for (const adapter of fullAdapters) {
    it(`${adapter.id} 至少有两个版本 fixture，且所有契约匹配`, async () => {
      const toolDir = join(FIXTURE_ROOT, adapter.id)
      const versionDirs = readdirSync(toolDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name !== 'synthetic' &&
            /^\d+\.\d+\.\d+/.test(entry.name)
        )
        .map((entry) => entry.name)
        .sort()

      expect(versionDirs.length).toBeGreaterThanOrEqual(2)
      for (const cliVersion of versionDirs) {
        const fixtureDir = join(toolDir, cliVersion)
        const expected = JSON.parse(
          readFileSync(join(fixtureDir, 'expected.json'), 'utf8')
        ) as FixtureExpectation
        expect(expected.toolId).toBe(adapter.id)
        expect(expected.cliVersion).toBe(cliVersion)
        expect(adapter.sessionStorage!.listSessionFiles(fixtureDir)).toHaveLength(1)
        expect(await evaluateFixture(expected, fixtureDir)).toEqual(expected)
      }
    })
  }

  it('人为篡改记录类型后契约不再匹配', async () => {
    const sourceDir = join(FIXTURE_ROOT, 'claude', '2.1.170')
    const targetDir = mkdtempSync(join(tmpdir(), 'agent-os-contract-'))
    tempDirs.push(targetDir)
    cpSync(sourceDir, targetDir, { recursive: true })

    const expected = JSON.parse(
      readFileSync(join(targetDir, 'expected.json'), 'utf8')
    ) as FixtureExpectation
    const fixturePath = join(targetDir, expected.file)
    const original = readFileSync(fixturePath, 'utf8')
    const mutated = original.replace('"type":"user"', '"type":"future-mutated"')
    expect(mutated).not.toBe(original)
    writeFileSync(fixturePath, mutated)

    expect(await evaluateFixture(expected, targetDir)).not.toEqual(expected)
  })
})
