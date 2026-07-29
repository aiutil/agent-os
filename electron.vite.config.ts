import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)
const { buildLocalReleaseProvenance } = require('./scripts/release-provenance.cjs') as {
  buildLocalReleaseProvenance(root?: string): { sourceRevision: string }
}
const sourceRevision = buildLocalReleaseProvenance(resolve('.')).sourceRevision

// electron-vite 三段式配置：main（Node/ESM）、preload（contextBridge）、renderer（React/Vite）。
// externalizeDepsPlugin 把 node-pty / electron-store 等 native/CJS 依赖从打包中剔除，
// 由 electron-builder install-app-deps 在安装期重建 native 模块。
export default defineConfig(({ mode }) => {
  const analyticsEnv = loadEnv(mode, resolve('.'), ['MIXPANEL_'])
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        __AGENT_OS_SOURCE_REVISION__: JSON.stringify(sourceRevision),
        __MIXPANEL_PRODUCTION_TOKEN__: JSON.stringify(
          analyticsEnv['MIXPANEL_PRODUCTION_TOKEN'] ?? ''
        ),
        __MIXPANEL_DEVELOPMENT_TOKEN__: JSON.stringify(analyticsEnv['MIXPANEL_DEV_TOKEN'] ?? '')
      },
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            daemon: resolve('src/main/daemon.ts'),
            'remote-node': resolve('src/main/remote-node.ts'),
            'agent-os': resolve('src/main/cli.ts'),
            'agent-os-memory': resolve('src/main/memory-cli.ts')
          }
        }
      },
      resolve: {
        alias: { '@shared': resolve('src/shared') }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: { '@shared': resolve('src/shared') }
      }
    },
    renderer: {
      resolve: {
        alias: {
          '@shared': resolve('src/shared'),
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react()]
    }
  }
})
