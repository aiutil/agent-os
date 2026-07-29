import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { scrubFixtureContent } from '../src/main/domains/diagnostics/fixture-scrubber'

async function main(): Promise<void> {
  const [, , inputPath, outputPath] = process.argv
  if (!inputPath || !outputPath) {
    throw new Error(
      '用法：npm run fixture:scrub -- <input.jsonl> <output.jsonl>'
    )
  }

  const source = await readFile(inputPath, 'utf8')
  const scrubbed = scrubFixtureContent(source)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${scrubbed.trimEnd()}\n`, 'utf8')
}

void main()
