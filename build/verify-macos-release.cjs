#!/usr/bin/env node
/* Verify the fixed self-signature inside a release DMG; this does not claim Gatekeeper trust. */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const dmg = process.argv[2]
if (!dmg || !fs.existsSync(dmg)) {
  console.error(`Usage: node build/verify-macos-release.cjs <release.dmg>`)
  process.exit(2)
}

const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-os-dmg-'))
let attached = false
try {
  execFileSync('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mountPoint], {
    stdio: 'inherit'
  })
  attached = true
  const app = fs.readdirSync(mountPoint).find((name) => name.endsWith('.app'))
  if (!app) throw new Error(`DMG does not contain an .app: ${dmg}`)
  const appPath = path.join(mountPoint, app)
  const signature = spawnSync('codesign', ['-dvv', appPath], { encoding: 'utf8' })
  if (signature.status !== 0) {
    throw new Error(`codesign inspection failed: ${signature.stderr || signature.stdout}`)
  }
  const signatureDetails = `${signature.stdout || ''}\n${signature.stderr || ''}`
  if (signatureDetails.includes('Signature=adhoc')) {
    throw new Error('ad-hoc signature is not allowed for a release build')
  }
  if (!signatureDetails.includes('Authority=Agent OS Self-Signed')) {
    throw new Error('release build is not signed by the fixed Agent OS Self-Signed identity')
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit'
  })
  console.log(`✓ macOS fixed self-signature verified (not notarized/Gatekeeper-trusted): ${dmg}`)
} finally {
  if (attached) {
    try {
      execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'inherit' })
    } catch (error) {
      console.error(
        `Failed to detach ${mountPoint}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  fs.rmSync(mountPoint, { recursive: true, force: true })
}
