# Agent OS

[English](README.md) · [产品页](https://agentos.aiutil.com) · [AIUtil](https://aiutil.com)

Agent OS 是一款桌面端 Agent 工作台，用来运行、比较和审阅多个受支持 AI
编程 CLI 的工作。它把会话、任务看板、定时任务、远程运行节点、消息渠道、
本地搜索和运行记录放在同一个应用里。

本仓库同时包含应用源码与产品站。原 `agent-life` 仓库只是 Agent OS 的产品
展示页，不是另一个产品，现在已经合并到本仓库。

## 当前版本

`0.3.9` 提供 macOS、Windows 和 Linux 构建，可从
[GitHub Releases](https://github.com/aiutil/agent-os/releases) 下载。

## 本地开发

```bash
npm ci
npm run dev
```

提交变更前运行：

```bash
npm run typecheck
npm test
npm run lint
```

Electron 应用位于 `src/`，构建与发布工具位于 `scripts/`，静态产品站位于
`site/`。

## 开源协议

本项目采用 Apache License 2.0。第三方组件仍适用各自的许可证，详见
[NOTICE](NOTICE)。
