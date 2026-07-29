// SPEC-032 Docker E2E helper: render the exact desktop one-liner and Unix installer
// from the production pure functions after the test gateway certificate is known.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  oneLiners,
  unixInstallScript,
  type InstallScriptParams
} from '../src/main/domains/runtime/node-install-scripts'

const configPath = process.argv[2]
const outputDirectory = process.argv[3]
if (!configPath || !outputDirectory) {
  throw new Error('usage: vite-node scripts/render-node-enroll-fixture.ts <config.json> <output-dir>')
}

const params = JSON.parse(readFileSync(configPath, 'utf8')) as InstallScriptParams
mkdirSync(outputDirectory, { recursive: true })
writeFileSync(join(outputDirectory, 'install.sh'), unixInstallScript(params), { mode: 0o600 })
writeFileSync(join(outputDirectory, 'one-liner.sh'), `${oneLiners(params).unix}\n`, { mode: 0o700 })
