import type {
  PermissionDecision,
  CreateTaskInput,
  CreateSessionInput,
  HostEvent,
  ListRuntimeDirectoriesInput,
  UpdateSessionPatch,
  UpdateTaskPatch
} from '@shared/types'
import type { TurnContextPack } from '@shared/types'

export const DAEMON_RPC_METHODS = [
  'hello',
  'hostStatus',
  'probeTerminal',
  'listRuntimes',
  'listModels',
  'listDirectories',
  'listSessions',
  'listSessionViews',
  'createSession',
  'resumeSession',
  'openLinkedTerminal',
  'updateSession',
  'removeSession',
  'write',
  'resize',
  'history',
  'state',
  'states',
  'kill',
  'sendTurn',
  'steerTurn',
  'queueTurn',
  'listQueuedTurns',
  'cancelQueuedTurn',
  'interruptTurn',
  'respondPermission',
  'chatState',
  'chatHistory',
  'chatTimeline',
  'listTasks',
  'listTaskRuns',
  'createTask',
  'updateTask',
  'removeTask',
  'runTaskNow'
] as const

export type DaemonRpcMethod = (typeof DAEMON_RPC_METHODS)[number]

const daemonRpcMethodSet = new Set<string>(DAEMON_RPC_METHODS)

export function isDaemonRpcMethod(value: unknown): value is DaemonRpcMethod {
  return typeof value === 'string' && daemonRpcMethodSet.has(value)
}

export type DaemonRpcParams =
  | []
  | [CreateSessionInput]
  | [CreateTaskInput]
  | [ListRuntimeDirectoriesInput]
  | [string]
  | [string, string]
  | [string, number, number]
  | [string, UpdateSessionPatch]
  | [string, UpdateTaskPatch]
  | [string, string, PermissionDecision]
  | [string, string, string[]]
  | [string, string, string[], TurnContextPack]

export interface DaemonRpcRequest {
  type: 'request'
  id: string
  method: DaemonRpcMethod
  params: DaemonRpcParams
}

export interface DaemonRpcResponse {
  type: 'response'
  id: string
  result?: unknown
  error?: string
}

export interface DaemonEventEnvelope {
  type: 'event'
  event: HostEvent
}

export interface DaemonHeartbeat {
  type: 'heartbeat'
  at: number
}

/** 主控在注册收口前，通过远程 RPC 要求节点实际启动一次 node-pty 子进程。 */
export interface DaemonTerminalProbe {
  ok: true
  backend: 'node-pty'
  nodeVersion: string
  nodeAbi: string
  platform: NodeJS.Platform
  arch: string
}

/**
 * SPEC-032：节点反向拨回主控后，连上即发一次身份上报。
 * 由主控网关层拦截消费；RPC 服务端/驱动端都安全忽略它。
 */
export interface DaemonRegister {
  type: 'register'
  label: string
  platform?: string
  hostVersion?: string
  protocolVersion: number
}

/** 主控在已验证证书的 WSS 内下发长期节点凭证。 */
export interface DaemonEnrollmentAccepted {
  type: 'enrollment-accepted'
  nodeToken: string
}

/** 节点完成凭证原子持久化后确认，主控此时才消费 enrollment。 */
export interface DaemonEnrollmentConfirmed {
  type: 'enrollment-confirmed'
}

/** 主控完成 hello、协议、PTY 与 Agent 发现后，明确确认该 socket 已被接管。 */
export interface DaemonNodeAdopted {
  type: 'node-adopted'
  nodeId: string
  hostVersion: string
  protocolVersion: number
  adoptedAt: string
}

/** 节点完成本地 adopted 状态持久化后回执，主控收到后才向安装器报告成功。 */
export interface DaemonNodeAdoptedConfirmed {
  type: 'node-adopted-confirmed'
  nodeId: string
  adoptedAt: string
}

export type DaemonEnvelope =
  | DaemonRpcRequest
  | DaemonRpcResponse
  | DaemonEventEnvelope
  | DaemonHeartbeat
  | DaemonRegister
  | DaemonEnrollmentAccepted
  | DaemonEnrollmentConfirmed
  | DaemonNodeAdopted
  | DaemonNodeAdoptedConfirmed

export function parseDaemonEnvelope(raw: string): DaemonEnvelope {
  const parsed = JSON.parse(raw) as DaemonEnvelope
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    throw new Error('无效 daemon 消息')
  }
  return parsed
}
