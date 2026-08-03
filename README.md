# Agent OS

[简体中文](README.zh-CN.md) · [Product site](https://agentos.aiutil.com) · [AIUtil](https://aiutil.com)

Agent OS is a desktop workbench for running and reviewing work across supported
AI coding CLIs. It brings sessions, task boards, schedules, remote runtime
nodes, message channels, local search, and run history into one application.

The repository now contains both the application source and the product site.
The former `agent-life` repository was the product-page repository, not a
separate product.

## Current release

Version `0.3.9` provides builds for macOS, Windows, and Linux. Download them
from [GitHub Releases](https://github.com/aiutil/agent-os/releases).

## Development

```bash
npm ci
npm run dev
```

Before submitting a change:

```bash
npm run typecheck
npm test
npm run lint
```

The Electron application lives in `src/`; packaging and release tooling lives
in `scripts/`; the static product site lives in `site/`.

## License

Apache License 2.0. Third-party components remain under their respective
licenses; see [NOTICE](NOTICE).
