// 内置适配器注册表（SPEC-003）。
// 高质量适配器统一在此注册。新增 CLI 只需追加声明式条目与对应数据面。

import { parseSemver, shellQuote, type CliAdapter } from './types'
import { claudeSessionStorage } from './claude/storage'
import { buildClaudeHeadlessTurn, createClaudeParser } from './claude/control'
import { codexSessionStorage } from './codex/storage'
import { buildCodexHeadlessTurn, createCodexParser } from './codex/control'
import { buildOpenCodeHeadlessTurn, createOpenCodeParser } from './opencode/control'
import { buildCursorAgentHeadlessTurn, createCursorAgentParser } from './cursor-agent/control'
import { buildGeminiHeadlessTurn, createGeminiParser } from './gemini/control'
import { buildHermesHeadlessTurn, createHermesParser } from './hermes/control'
import { buildOpenClawHeadlessTurn, createOpenClawParser } from './openclaw/control'
import { geminiSessionStorage } from './gemini/storage'
import { hermesSessionStorage } from './hermes/storage'
import { opencodeSessionStorage } from './opencode/storage'
import { piSessionStorage } from './pi/storage'
import { buildPiHeadlessTurn, createPiParser } from './pi/control'
import { toolDisplayName } from '@shared/tool-display'

const claude: CliAdapter = {
  id: 'claude',
  displayName: toolDisplayName('claude'),
  executable: 'claude',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  installHint: 'curl -fsSL https://claude.ai/install.sh | bash',
  runtime: 'native / npm global',
  lifecycle: {
    install: { method: 'shell', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
    updateCommand: 'claude update'
  },
  providerEnvironment: {
    apiKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'ANTHROPIC_BASE_URL',
    model: 'ANTHROPIC_MODEL'
  },
  supportsSessionIdInjection: true,
  buildLaunchCommand: ({ nativeSessionId, model, reasoningEffort }) => {
    const base = nativeSessionId ? `claude --session-id ${shellQuote(nativeSessionId)}` : 'claude'
    const withModel = model ? `${base} --model ${shellQuote(model)}` : base
    return reasoningEffort
      ? `${withModel} --effort ${shellQuote(reasoningEffort)}`
      : withModel
  },
  buildResumeCommand: (nativeSessionId) => `claude --resume ${shellQuote(nativeSessionId)}`,
  headlessJson: {
    supportsPersistentStream: false,
    supportsNativeResume: true,
    attachments: { images: true, files: true },
    buildTurn: buildClaudeHeadlessTurn,
    createParser: createClaudeParser
  },
  sessionStorage: claudeSessionStorage
}

const codex: CliAdapter = {
  id: 'codex',
  displayName: toolDisplayName('codex'),
  executable: 'codex',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  installHint: 'npm i -g @openai/codex@latest',
  runtime: 'npm global',
  lifecycle: {
    install: { method: 'npm', packageName: '@openai/codex@latest' },
    updateCommand: 'codex update'
  },
  providerEnvironment: {
    apiKey: 'OPENAI_API_KEY',
    baseUrl: 'OPENAI_BASE_URL'
  },
  buildLaunchCommand: ({ model, reasoningEffort }) => {
    const base = model ? `codex --model ${shellQuote(model)}` : 'codex'
    return reasoningEffort
      ? `${base} -c ${shellQuote(`model_reasoning_effort="${reasoningEffort}"`)}`
      : base
  },
  buildResumeCommand: (nativeSessionId) => `codex resume ${shellQuote(nativeSessionId)}`,
  headlessJson: {
    supportsPersistentStream: false,
    supportsNativeResume: false,
    attachments: {
      images: true,
      files: false,
      allowedExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp']
    },
    buildTurn: buildCodexHeadlessTurn,
    createParser: createCodexParser
  },
  sessionStorage: codexSessionStorage
}

const gemini: CliAdapter = {
  id: 'gemini',
  displayName: toolDisplayName('gemini'),
  executable: 'gemini',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  installHint: 'npm i -g @google/gemini-cli@latest',
  runtime: 'npm global',
  lifecycle: {
    install: { method: 'npm', packageName: '@google/gemini-cli@latest' },
    updateCommand: 'npm install --global @google/gemini-cli@latest'
  },
  providerEnvironment: {
    apiKey: 'GEMINI_API_KEY'
  },
  buildLaunchCommand: ({ model }) =>
    model ? `gemini --skip-trust --model ${shellQuote(model)}` : 'gemini --skip-trust',
  buildResumeCommand: (nativeSessionId) => `gemini --skip-trust --resume ${shellQuote(nativeSessionId)}`,
  headlessJson: {
    supportsPersistentStream: false,
    supportsNativeResume: true,
    attachments: { images: true, files: true },
    buildTurn: buildGeminiHeadlessTurn,
    createParser: createGeminiParser
  },
  sessionStorage: geminiSessionStorage
}

const opencode: CliAdapter = {
  id: 'opencode',
  displayName: toolDisplayName('opencode'),
  executable: 'opencode',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  installHint: 'curl -fsSL https://opencode.ai/install | bash',
  runtime: 'native',
  lifecycle: {
    install: { method: 'shell', command: 'curl -fsSL https://opencode.ai/install | bash' },
    updateCommand: 'opencode upgrade'
  },
  buildLaunchCommand: ({ model, reasoningEffort }) => {
    const base = model ? `opencode --model ${shellQuote(model)}` : 'opencode'
    return reasoningEffort
      ? `${base} --variant ${shellQuote(reasoningEffort)}`
      : base
  },
  buildResumeCommand: (nativeSessionId) => `opencode --session ${shellQuote(nativeSessionId)}`,
  headlessJson: {
    supportsPersistentStream: false,
    supportsNativeResume: true,
    attachments: { images: true, files: true },
    buildTurn: buildOpenCodeHeadlessTurn,
    createParser: createOpenCodeParser
  },
  sessionStorage: opencodeSessionStorage
}

const hermes: CliAdapter = {
  id: 'hermes',
  displayName: toolDisplayName('hermes'),
  executable: 'hermes',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  installHint: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash',
  runtime: 'Python',
  lifecycle: {
    install: {
      method: 'shell',
      command: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'
    },
    updateCommand: 'hermes update'
  },
  buildLaunchCommand: ({ model }) => (model ? `hermes --model ${shellQuote(model)}` : 'hermes'),
  buildResumeCommand: (nativeSessionId) => `hermes chat --resume ${shellQuote(nativeSessionId)}`,
  headlessJson: {
    supportsPersistentStream: false,
    supportsNativeResume: true,
    // hermes 是非交互批量 CLI：--query 把提示放进 argv、spawn 后我们又立即
    // stdin.end()（EOF），故进程必然自行退出——「完成」由进程 exit 信号驱动，
    // 而非 stdout 事件时序。hermes 用 Rich 面板在结束时才一次性渲染整段回答，
    // 全程静默；默认 90s「无事件即卡死」看门狗会把这种合法静默误判为卡死、杀掉
    // 正在进行的推理。故对 hermes 禁用该看门狗（null），信任进程生命周期；极少数
    // 真挂死由用户 interrupt() 兜底，而不是用拍脑袋的超时阈值去杀合法回合。
    startupTimeoutMs: null,
    attachments: {
      images: true,
      files: false,
      maxFiles: 1,
      allowedExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp']
    },
    buildTurn: buildHermesHeadlessTurn,
    createParser: createHermesParser
  },
  sessionStorage: hermesSessionStorage
}

const openclaw: CliAdapter = {
  id: 'openclaw',
  displayName: toolDisplayName('openclaw'),
  executable: 'openclaw',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  installHint: '请先安装 OpenClaw CLI，并确保 openclaw 在 PATH 中',
  runtime: 'native',
  buildLaunchCommand: ({ model }) =>
    model ? `openclaw --model ${shellQuote(model)}` : 'openclaw',
  buildResumeCommand: (nativeSessionId) => `openclaw chat --resume ${shellQuote(nativeSessionId)}`,
  headlessJson: {
    supportsPersistentStream: false,
    supportsNativeResume: true,
    attachments: { images: false, files: false },
    buildTurn: buildOpenClawHeadlessTurn,
    createParser: createOpenClawParser
  }
}

const pi: CliAdapter = {
  id: 'pi',
  displayName: toolDisplayName('pi'),
  executable: 'pi',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  installHint: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
  runtime: 'npm global',
  lifecycle: {
    install: {
      method: 'shell',
      command: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'
    },
    updateCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'
  },
  buildLaunchCommand: ({ model, reasoningEffort }) => {
    const base = model ? `pi --model ${shellQuote(model)}` : 'pi'
    return reasoningEffort
      ? `${base} --thinking ${shellQuote(reasoningEffort)}`
      : base
  },
  headlessJson: {
    supportsPersistentStream: false,
    supportsIsolatedCuration: true,
    supportsNativeResume: true,
    attachments: { images: true, files: true },
    buildTurn: buildPiHeadlessTurn,
    createParser: createPiParser
  },
  sessionStorage: piSessionStorage
}

const cursorAgent: CliAdapter = {
  id: 'cursor-agent',
  displayName: toolDisplayName('cursor-agent'),
  executable: 'cursor-agent',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  installHint: 'curl https://cursor.com/install -fsS | bash',
  runtime: 'native',
  lifecycle: {
    install: { method: 'shell', command: 'curl https://cursor.com/install -fsS | bash' },
    updateCommand: 'cursor-agent update'
  },
  buildLaunchCommand: ({ model }) =>
    model ? `cursor-agent --model ${shellQuote(model)}` : 'cursor-agent',
  headlessJson: {
    supportsPersistentStream: false,
    supportsNativeResume: false,
    attachments: { images: false, files: false },
    buildTurn: buildCursorAgentHeadlessTurn,
    createParser: createCursorAgentParser
  }
}

/** Shell 兜底适配器：进入交互式 shell，不预置命令。 */
const shell: CliAdapter = {
  id: 'shell',
  displayName: toolDisplayName('shell'),
  executable: process.platform === 'win32' ? 'powershell' : 'zsh',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  installHint: '',
  runtime: 'system shell',
  buildLaunchCommand: () => ''
}

const ADAPTERS: CliAdapter[] = [
  claude,
  codex,
  cursorAgent,
  gemini,
  hermes,
  openclaw,
  opencode,
  pi,
  shell
]

const BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]))

export function listAdapters(): CliAdapter[] {
  return ADAPTERS
}

/** 可在工作台「新建会话」中选择的适配器（不含 shell 兜底外的隐藏项）。 */
export function listSelectableAdapters(): CliAdapter[] {
  return ADAPTERS
}

export function getAdapter(id: string): CliAdapter | undefined {
  return BY_ID.get(id)
}
