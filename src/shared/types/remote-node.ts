// 局域网远程 agent 节点相关类型。
// 路线 A（旧）：主控拨号节点（host/port/fingerprint + TOFU）。
// SPEC-032：节点反向拨回主控 + 远程托管（enabled/agents/enrollment）。
// 过渡期两套字段并存；传输层反转完成后移除旧字段（见 SPEC-032 §4 非目标）。

/** 节点平台标识（决定自包含 runtime 选哪份预编译原生模块）。 */
export type NodePlatform = 'linux-arm64' | 'linux-x64' | 'mac-arm64' | 'mac-x64' | 'win-x64'

/** 节点上发现的一个 agent CLI（节点自动发现并上报，主控侧可启停/改别名）。 */
export interface NodeAgentInfo {
  /** agent id，如 'claude' | 'codex' | 'cursor' | 'opencode'。 */
  id: string
  /** 节点上报的原始名。 */
  name: string
  /** 主控侧显示别名（如「书房·Claude」）；仅影响展示，不改 id/调度。 */
  alias?: string
  version?: string
  /** 主控侧覆盖后的有效启用状态。 */
  enabled: boolean
}

/** 已配对的远程节点（持久化）。token/cert 为敏感字段，存储需保护。 */
export interface RemoteNode {
  id: string
  label: string
  host: string
  port: number
  /** 长期接入 token（节点鉴权）。 */
  token: string
  /** 节点自签证书 SHA-256 指纹（大写冒号十六进制），用于 TOFU pin。 */
  fingerprint: string
  /** 节点自签证书 PEM；用于 rejectUnauthorized 的 ca pin。 */
  certPem?: string
  hostVersion?: string
  protocolVersion?: number
  addedAt: string
  lastConnectedAt?: string

  // ── SPEC-032 新增（过渡期可选，默认值见各自说明）──
  /** 节点级启停。未设视为启用（兼容旧数据）。 */
  enabled?: boolean
  /** 节点平台（节点上报）。 */
  platform?: NodePlatform
  /** 主控自签证书指纹（节点 pin 用，展示核对）。 */
  hostFingerprint?: string
  /** 每 agent 的启停 + 显示别名覆盖。 */
  agentOverrides?: Record<string, { enabled: boolean; alias?: string }>
}

/** 远程节点连接状态（推送给渲染端）。 */
export interface RemoteNodeStatus {
  id: string
  label: string
  host: string
  port: number
  connection: 'connecting' | 'connected' | 'disconnected' | 'disabled' | 'error'
  error?: string
  hostVersion?: string
  lastConnectedAt?: string

  // ── SPEC-032 新增 ──
  /** 节点级启停的有效值。 */
  enabled?: boolean
  /** 节点平台。 */
  platform?: NodePlatform
  /** 在线时上报的 agent 列表（含启停/别名）。 */
  agents?: NodeAgentInfo[]
}

/**
 * 一次性接入句柄（主控内存态，不长期持久化）：「添加节点」时生成，
 * 内嵌进一行安装脚本（含主机 LAN 地址 + nodeToken）；节点首次注册成功后失效。
 */
export interface NodeEnrollment {
  enrollId: string
  /** 只出现在短期 HTTP 安装脚本中，首注册后立即失效。 */
  enrollmentToken: string
  /** 长期节点凭证；只通过已 pin 证书的 WSS 下发，不进入 HTTP 脚本。 */
  nodeToken: string
  label: string
  createdAt: string
  expiresAt: string
  consumedAt?: string
  /** 首次下载脚本的客户端地址；短期换票只接受同一来源。 */
  deliveredTo?: string
  platform?: NodePlatform
  assetSha256?: string
}

/** 「添加节点」入参。 */
export interface CreateEnrollmentInput {
  label?: string
  /** 用户明确选择目标平台，安装脚本会拒绝在其他平台执行。 */
  platform: NodePlatform
}

/** 「添加节点」结果：返回复制即用的一行命令（三系统终端）。 */
export interface CreateEnrollmentResult {
  enrollId: string
  /** 主控 LAN 地址:端口。 */
  hostAddress: string
  /** unix=mac/Linux 的 sh 一行命令；powershell=Windows 的一行命令。 */
  commands: Record<'unix' | 'powershell', string>
  expiresAt: string
  platform?: NodePlatform
}

export interface NodeReleasePlatformReadiness {
  ready: boolean
  asset: string
  missing: string[]
  sha256?: string
}

/** 当前桌面版本对应的节点 Release 制品是否已完整发布。 */
export interface NodeReleaseReadiness {
  repo: string
  version: string
  checkedAt: string
  ready: boolean
  manifestAsset: string
  provenanceAsset: string
  platforms: Record<NodePlatform, NodeReleasePlatformReadiness>
  error?: string
}

/** 远程托管网关状态。 */
export interface NodeGatewayStatus {
  enabled: boolean
  host: string
  port: number
  fingerprint: string
  /** 当前桌面/网关发行版本，供节点版本偏差提示。 */
  version: string
  hostCandidates?: Array<{ interfaceName: string; address: string; recommended: boolean }>
  /** 网关未能启动时的可读原因（例如端口已被另一个 Agent OS 实例占用）。 */
  error?: string
}

/** 远程/本机 runtime 的目录浏览入参。hostId 缺省或为 local 时浏览本机。 */
export interface ListRuntimeDirectoriesInput {
  hostId?: string
  /** 为空时由目标主机返回默认目录（通常是 home）。 */
  path?: string
  /** 返回目录数量上限。 */
  limit?: number
}

/** 一个可选工作目录条目。仅返回目录，不返回普通文件。 */
export interface RuntimeDirectoryEntry {
  name: string
  path: string
  hidden: boolean
}

/** 目标主机上的目录浏览结果。 */
export interface RuntimeDirectoryListing {
  hostId?: string
  path: string
  home: string
  parent?: string
  entries: RuntimeDirectoryEntry[]
}

/** 「添加节点」探测结果（配对前给用户确认指纹）。 */
export interface RemoteNodeProbe {
  ok: boolean
  fingerprint?: string
  certPem?: string
  hostVersion?: string
  protocolVersion?: number
  error?: string
}

/** 添加远程节点入参（旧手填 IP 路径；SPEC-032 反向后移除）。 */
export interface AddRemoteNodeInput {
  label?: string
  host: string
  port: number
  token: string
}
