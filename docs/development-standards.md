# 开发标准（DDD / SDD / TDD）

## 1. 领域边界（DDD）

Agent OS v2 划分为以下稳定领域，每个领域有清晰的代码归属，跨域只能经由 IPC 契约或共享类型协作。

| 领域 | 职责 | 代码位置 | 关键类型 |
|------|------|---------|---------|
| **CLI 接入（Discovery/Adapter）** | 自动发现本机 CLI、统一驱动协议、BYOK 兜底 | `src/main/domains/discovery`、`src/main/domains/adapters` | `DiscoveryResult`、`CliAdapter` |
| **终端会话（Terminal）** | PTY 生命周期、运行状态机 | `src/main/domains/terminal` | `TerminalRunState`、`TerminalManager` |
| **运行时宿主（Runtime）** | 会话生命周期编排、终端操作、统一事件流 | `src/main/domains/runtime` | `RuntimeHost`、`HostEvent` |
| **工作台会话（Session）** | 会话元数据持久化、视图模型、按项目分组 | `src/main/domains/sessions` | `WorkbenchSession`、`WorkbenchSessionView` |
| **记忆（Memory）** | 跨工具会话搜索、经验库（SPEC-007，待建） | `src/main/domains/memory` | — |
| **统计（Stats）** | 成本/活跃/成长（SPEC-008） | `src/main/domains/stats` | 只消费统一 transcript 索引与真实经验条目 |
| **对比（Compare）** | 多 CLI 同任务 worktree 隔离对比（SPEC-009，待建） | `src/main/domains/compare` | — |

边界原则：
- 上层（会话/对比/记忆）通过 `CliAdapter` 协议驱动 CLI，不直接关心具体 CLI 差异。
- 终端域只负责「把命令跑起来 + 报告状态」，不理解 CLI 语义。
- IPC 不直接组合 Session / Adapter / Terminal；运行时相关请求统一委托 `RuntimeHost`。
- 渲染端通过 `window.agentOs`（强类型 IPC）访问主进程，不直接 import 主进程模块。

## 2. SDD（spec 驱动）

- 所有跨模块功能先有编号 SPEC（`docs/specs/`）。
- SPEC 状态机：`draft → approved → implemented`（大改写新版本）。
- SPEC 必含：背景/证据、目标、非目标、数据结构、IPC 契约、状态机、错误处理、验收标准、测试计划。

## 3. TDD（按制品类型）

| 制品类型 | 测试策略 |
|---------|---------|
| 状态机（如 `run-state.ts`） | 必须有状态迁移测试矩阵：每个迁移 + 边界（退出后 data、未知 id） |
| 数据解析（如 discovery providers） | 正常 / 异常 / 缺失 / 跨平台用例 |
| IPC/API 契约 | 类型层面静态保证（`ipc-contract.ts`）；handler 行为单测 |
| 纯视图模型（如 `view.ts`） | 输入→输出快照式断言 |
| UI 组件 | 空态 / 加载 / 失败 / 完成态；可视化改动真机验证 |

纯逻辑（不依赖 electron/node-pty native）放在可单测的纯函数/纯类中，native 依赖隔离在边界层（`manager.ts`、`index.ts`），便于 Vitest 覆盖核心逻辑。

## 4. 构建者/验证者分离（Builder cannot self-verify）

写代码的人不能凭自己跑的「全绿」声称完成——这等价于「本地跑过≠CI 通过」。本仓库设一道硬门禁：触碰 `src/` 或 `tests/` 的改动，测试环境（`npm test` / `npm run typecheck` / `npm run build`）**必须由 `qa-verify` subagent（`.claude/agents/qa-verify.md`）在干净上下文重跑**，以其返回的 `verdict + evidence` 为唯一验收证据。

- **构建者自检允许**：Build 期间可自跑测试快速迭代，但结果**不计入验收**。
- **subagent 独立验证强制**：进 Ship 前，构建者移交一份 Verify 工作包（格式见 `agent-context.md`），由 `qa-verify` 重跑并如实回报（零信任、禁止静默改代码刷绿）。
- **豁免**：改动未触碰 `src/` 与 `tests/`（纯文档 / SPEC / 配置 / `.claude`）时免 subagent，Ship 时注明「纯文档免验证 subagent」。
- 类比：构建者 = 提 PR 的人，`qa-verify` = 本地 CI；PR 作者自测通过不等于 CI 绿。

## 5. 命名与风格

- 主进程/共享：TS + ESM，文件 kebab-case，类型 PascalCase。
- 渲染组件：PascalCase 文件名 + 同名 CSS。
- 颜色/字体/间距/圆角/动效：只用 `tokens.css` 变量。
- 注释解释「为什么」，匹配周边代码的注释密度与语言（中文为主）。
