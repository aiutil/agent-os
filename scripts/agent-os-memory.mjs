#!/usr/bin/env node
/* global console, process */
// 使用 Electron 自带的 Node ABI 运行本地 Memory Gateway，保证 better-sqlite3 与桌面端一致。
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const entry = join(scriptDir, '..', 'out', 'main', 'agent-os-memory.js')
const child = spawn(electron, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

child.on('error', (error) => {
  console.error(`agent-os-memory: ${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
