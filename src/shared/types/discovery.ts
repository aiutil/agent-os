// CLI 自动发现领域模型（SPEC-002）。
// 重写自 v1 electron/cli-discovery-providers.cjs 的证据模型，全 TS 化。

/** 命令文件类型，用于平台差异处理。 */
export type CommandType = 'exe' | 'cmd' | 'ps1' | 'shell' | 'unknown'

/** 单个发现 provider 的探测证据（非侵入，仅读取环境/文件系统）。 */
export interface DiscoveryEvidence {
  /** provider 名称，如 EnvPathProvider / NpmGlobalProvider。 */
  provider: string
  /** 本次探测检查过的路径，用于诊断「为什么没发现」。 */
  checkedPaths: string[]
  /** 命中的可执行路径（命中时存在）。 */
  matchedPath?: string
  commandType?: CommandType
  error?: string
}

/** CLI 健康状态。 */
export type CliHealth =
  | 'ready' // 就绪：已安装、可执行
  | 'updatable' // 可更新：已装但有新版本
  | 'missing' // 未安装：PATH 未发现
  | 'failed' // 失败：发现但探测/执行异常

/** 一个 CLI 工具的发现结果。 */
export interface DiscoveryResult {
  /** 适配器 id：claude | codex | gemini | opencode ... */
  toolId: string
  /** 展示名。 */
  displayName: string
  /** 探测用的可执行名。 */
  executable: string
  health: CliHealth
  /** 命中的可执行绝对路径。 */
  executablePath?: string
  commandType?: CommandType
  /** 版本号（能解析到时）。 */
  version?: string
  /** 运行时来源描述，如 "npm global" / "homebrew"。 */
  runtime?: string
  /** 该适配器是否具备结构化聊天（对话镜头）通道，用于放开「对话」界面（SPEC-019）。 */
  supportsChat?: boolean
  /** 各 provider 证据链，按探测顺序。 */
  evidence: DiscoveryEvidence[]
  /** 未发现时的修复建议（安装命令等）。 */
  suggestedFixes?: string[]
  /** 发现耗时（ms）。 */
  scanDurationMs?: number
}

export interface ReasoningEffortOption {
  /** 原生 CLI 接受的字面值。 */
  id: string
  label: string
  isDefault?: boolean
}

export type ModelInputModality = 'text' | 'image' | 'file' | 'pdf'

/** 当前安装 CLI 的原生目录返回的一条真实模型。 */
export interface ToolModelInfo {
  id: string
  label: string
  provider?: string
  isDefault?: boolean
  reasoningEfforts?: ReasoningEffortOption[]
  inputModalities?: ModelInputModality[]
}

/**
 * 模型目录必须来自 Agent 原生协议、命令或 Agent 自己的缓存。`unavailable`
 * 表示该 Agent 没有机器可读目录或本次发现失败；消费者不得自行补静态模型。
 */
export interface ToolModelCatalog {
  models: ToolModelInfo[]
  source: 'native' | 'native-cache' | 'unavailable'
  /** CLI 原生 `--model` 接受任意 ID 时，UI 可提供手工输入。 */
  supportsCustomModel: boolean
  /** CLI 级思考级别（模型目录无法逐模型表达时使用）。 */
  reasoningEfforts?: ReasoningEffortOption[]
  error?: string
}
