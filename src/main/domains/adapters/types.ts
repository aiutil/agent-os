import type { AdapterSessionStorage } from '../../../shared/types/transcript'
import type {
  AgentEvent,
  ChatTurnMessage,
  PermissionPreset
} from '../../../shared/types/agent-event'
import type { RuntimeAttachmentCapabilities } from '../../../shared/types/runtime'

// 适配器协议 CliAdapter（SPEC-003）。
// 借鉴 v2 设计 §15.3：把每个 CLI 抽象为统一能力接口，使会话/对比/记忆等上层逻辑
// 无需关心具体 CLI 差异。切换 CLI 是配置变更，而非重写。
//
// 设计取舍：v1 把 PTY 逻辑散落在各处；v2 让适配器保持「声明式元数据 + 命令构造」，
// 真正的 PTY 生命周期集中在 terminal/manager.ts。这样新增一个 CLI 只需补一份元数据，
// 不必碰 PTY 代码（落实「优先做 3–5 个高质量适配器」的维护策略）。

export interface LaunchCommandInput {
  cwd: string
  /** 可选模型覆盖（BYOK / CLI 默认外）。 */
  model?: string
  /** Agent 原生思考级别/模型变体覆盖。 */
  reasoningEffort?: string
  /** 支持启动注入的 CLI 使用此 id 建立确定性绑定。 */
  nativeSessionId?: string
}

export type LifecycleInstall =
  | { method: 'npm'; packageName: string }
  | { method: 'shell'; command: string }

export interface AdapterLifecycle {
  install: LifecycleInstall
  updateCommand: string
}

export interface AdapterProviderEnvironment {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface HeadlessTurnInput {
  /** 本回合最新一条用户消息。 */
  prompt?: string
  /** 已绑定的 CLI 原生会话 id（用于支持原生 resume 的适配器）。 */
  nativeSessionId?: string
  model?: string
  /** Agent 原生思考级别/模型变体；空值由 CLI 自行决定。 */
  reasoningEffort?: string
  /**
   * 仅用于记忆提炼等数据处理回合。支持该能力的 adapter 必须禁用工具、会话持久化和
   * 项目级上下文加载，避免 curator 访问或改写工作区。
   */
  isolated?: boolean
  /** 会话级权限预设；适配器据此映射各自的 sandbox/trust/permission 启动参数。 */
  permissionPreset?: PermissionPreset
  /**
   * 先前回合消息（不含本回合 prompt）。仅当 `supportsNativeResume === false`
   * 时由宿主提供，供适配器把历史重组进 prompt 实现多回合连续（SPEC-019）。
   */
  transcript?: ChatTurnMessage[]
  /** 附件文件路径列表（本地磁盘路径）。支持的适配器会通过 --file 等机制传递给 CLI。 */
  files?: string[]
  /** Claude PreToolUse 审批 hook 地址；仅支持交互式审批的适配器使用。 */
  approvalUrl: string
  approvalToken: string
  turnId: string
}

export interface HeadlessTurnLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  /** 要写入子进程 stdin 的内容（prompt / 组合 transcript）。空则不写 stdin。 */
  stdin?: string
}

/** 每回合一个、持有跨行解析状态的解析器（tool id 去重、文本边界拼接等）。 */
export interface HeadlessTurnParser {
  parse(line: string): AgentEvent[]
}

export interface HeadlessJsonChannel {
  supportsPersistentStream: boolean
  /** 是否可以以无工具、无会话、无项目上下文的隔离模式运行。 */
  supportsIsolatedCuration?: boolean
  /**
   * 适配器的 CLI 是否自带多回合会话记忆。
   * true：宿主用原生 resume + 仅发最新一条；false：宿主注入 transcript。
   */
  supportsNativeResume: boolean
  /** CLI 原生附件能力；adapter 在 buildTurn 内翻译为本 CLI 参数。 */
  attachments: RuntimeAttachmentCapabilities
  buildTurn(input: HeadlessTurnInput): HeadlessTurnLaunch
  /** 每个回合创建一个解析器实例，持有该回合的跨行状态。 */
  createParser(): HeadlessTurnParser
  /**
   * 启动看门狗超时（毫秒）：spawn 后若在此时间内未观察到任何 agent 事件则判为启动
   * 卡死并 failTurn。流式 CLI（claude/codex/gemini，开局即吐事件）用默认 90s；批量
   * CLI（hermes --quiet 仅在结束才输出最终回答）需放宽（如 600_000），null 表示禁用
   * 看门狗、仅依赖进程退出收尾。
   */
  startupTimeoutMs?: number | null
}

export interface CliAdapter {
  /** 适配器 id：claude | codex | gemini | opencode ... */
  id: string
  displayName: string
  /** 发现时探测的可执行名。 */
  executable: string
  /** 读取版本号的参数，如 ['--version']。 */
  versionArgs: string[]
  /** 从版本命令输出解析版本号。 */
  parseVersion(output: string): string | undefined
  /** 未安装时的建议安装命令（首启动引导/诊断展示）。 */
  installHint: string
  /** 运行时来源描述。 */
  runtime: string
  /** 在 PTY 中启动该 CLI 的命令；返回空串表示仅进入交互式 shell。 */
  buildLaunchCommand(input: LaunchCommandInput): string
  /** 安装与升级命令元数据（SPEC-010）。 */
  lifecycle?: AdapterLifecycle
  /** 支持在单次 CLI 进程中注入的 Provider 环境变量名。 */
  providerEnvironment?: AdapterProviderEnvironment
  /** 是否能在新建时注入原生会话 id。 */
  supportsSessionIdInjection?: boolean
  /** 恢复已有原生会话的命令。 */
  buildResumeCommand?(nativeSessionId: string, cwd: string): string
  /** CLI 私有会话文件的数据面能力（SPEC-013）。 */
  sessionStorage?: AdapterSessionStorage
  /** 结构化聊天控制面能力（SPEC-016）。 */
  headlessJson?: HeadlessJsonChannel
}

/**
 * 单参数转义。macOS/Linux 走 POSIX 单引号；Windows 走 PowerShell 单引号字符串
 * （内嵌单引号用两个连续单引号转义，且不触发 $ 展开）。PTY 启动链在 macOS/Linux
 * 仍用 shell，Windows 用 PowerShell，故转义需按平台区分。
 */
export function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `'${value.replace(/'/g, "''")}'`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 通用 semver 解析，覆盖 "1.2.3"、"v1.2.3"、"x.y.z (foo)" 等输出。 */
export function parseSemver(output: string): string | undefined {
  const match = String(output || '').match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*/)
  return match ? match[0] : undefined
}
