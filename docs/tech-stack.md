# 技术选型（Tech Stack）

> 版本：2026-06-12 · 对应 SPEC-000

## 选型总表

| 维度 | 选型 | 理由 |
|------|------|------|
| 桌面壳 | Electron 33 | v2 价值靠 OS 级集成（原生终端、PTY）；对齐 v1 大版本降低 native 风险 |
| 构建 | **electron-vite 2** | 同时优雅支持 TS+ESM 主进程 / Vite renderer / HMR / native 模块 externalize |
| 打包 | electron-builder 25 + @electron/rebuild | 三平台产物；native 模块安装期重建 |
| 前端 | React 18 + TypeScript 5（strict） | 团队熟悉；strict 保证类型安全 |
| 状态 | **Zustand 5**（按域分 store） | 多入口共享会话/工具/UI 状态，轻量无样板 |
| 样式 | **CSS 变量设计 token + 按组件拆 CSS** | 落地 v2 暖浅设计系统；避免 v1 的 261KB 单体 CSS |
| 终端 UI | @xterm/xterm 5 + @xterm/addon-fit | v1 验证过的方案 |
| PTY | node-pty 1.1 | 真实 CLI 驱动；electron-vite externalize + rebuild |
| 持久化 | electron-store 10 | 配置/会话元数据；薄 TS 封装 |
| 发现 | fast-glob + child_process 探测 | PATH/包管理器/版本管理器扫描 |
| 测试 | **Vitest 2** | 与 Vite/ESM/TS 同源；覆盖纯逻辑 domain |
| Lint | ESLint 9 (flat) + Prettier + typescript-eslint | 质量门 |

## 关键决策（与 v1 的差异）

1. **主进程从 `.cjs` 无类型 → 全 TypeScript + ESM。** IPC 契约可静态校验，长期可维护性优先于迁移摩擦。
2. **从直接搬运 v1 代码 → 干净重写。** v1 仅作参考蓝本（发现逻辑、状态机、设计 token），重写为类型化 TS，隔离 native 依赖以便单测。
3. **从单体 CSS → token 变量 + 组件级 CSS。** 设计系统集中在 `tokens.css`，组件只引用变量。
4. **引入 Zustand。** v1 纯 hooks 在 v2 多入口共享状态下会偏复杂。

## 构建产物

- `out/main/index.js`（ESM 主进程）
- `out/preload/index.mjs`（预加载）
- `out/renderer/`（React 静态资源）
- `release/`（electron-builder 安装包）

## 为什么是 electron-vite 而非裸 Vite + 手写 main 构建

electron-vite 内建三段（main/preload/renderer）配置、`externalizeDepsPlugin`（自动把 node-pty 等 native/CJS 依赖移出打包）、`ELECTRON_RENDERER_URL` 注入与 HMR，省去手写 Rollup 多入口与 native 外置的样板。
