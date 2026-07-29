const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const electron = require('electron')

const result = spawnSync(
  electron,
  [resolve('node_modules', 'vitest', 'vitest.mjs'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    }
  }
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
