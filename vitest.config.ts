import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Vitest 仅覆盖纯逻辑单测（主进程 domain）。不加载 electron / node-pty native 模块的测试，
// 通过 mock 或仅测纯函数避免 native 依赖。
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
