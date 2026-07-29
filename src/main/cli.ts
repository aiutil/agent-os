#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RelayService } from './domains/relay/service'
import { readDaemonConfig } from './domains/runtime/daemon-config'
import { DaemonRuntimeHost } from './domains/runtime/daemon-runtime-host'
import {
  createDaemonRuntime,
  type DaemonRuntimeBundle
} from './domains/runtime/create-daemon-runtime'
import { RUNTIME_PROTOCOL_VERSION } from '@shared/types'
import type {
  CreateTaskInput,
  NormalizedTranscript,
  RelayTarget,
  RuntimeHost,
  StartRelayPayload,
  StartRelayResult
} from '@shared/types'

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface AgentOsCliDeps {
  startRelay(payload: StartRelayPayload): Promise<StartRelayResult>
  listRelayTargets(sourceSessionId: string): Promise<RelayTarget[]>
  runtime?: Pick<
    RuntimeHost,
    | 'hostStatus'
    | 'listRuntimes'
    | 'listSessionViews'
    | 'createSession'
    | 'sendTurn'
    | 'listTasks'
    | 'createTask'
    | 'runTaskNow'
  >
  close(): Promise<void>
}

interface ParsedFlags {
  command?: string
  from?: string
  to?: string
  session?: string
  task?: string
  tool?: string
  prompt?: string
  workspace?: string
  title?: string
  model?: string
  at?: string
  dataDir?: string
  json: boolean
  help: boolean
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

function parseArgs(args: string[]): ParsedFlags {
  return {
    command: args[0],
    from: flagValue(args, '--from'),
    to: flagValue(args, '--to'),
    session: flagValue(args, '--session'),
    task: flagValue(args, '--task'),
    tool: flagValue(args, '--tool'),
    prompt: flagValue(args, '--prompt'),
    workspace: flagValue(args, '--workspace'),
    title: flagValue(args, '--title'),
    model: flagValue(args, '--model'),
    at: flagValue(args, '--at'),
    dataDir: flagValue(args, '--data-dir') ?? process.env['AGENT_OS_DATA_DIR'],
    json: args.includes('--json'),
    help: args.includes('--help') || args.includes('-h')
  }
}

function usage(): string {
  return [
    'Agent OS CLI',
    '',
    'agent-os status [--json]',
    'agent-os agents [--json]',
    'agent-os sessions [--json]',
    'agent-os session-create --tool <toolId> [--workspace <path>] [--title <name>] [--model <id>] [--json]',
    'agent-os send --session <sessionId> --prompt <text> [--json]',
    'agent-os tasks [--json]',
    'agent-os task-create --title <title> --prompt <text> --tool <toolId> [--workspace <path>] [--at <ISO>] [--json]',
    'agent-os task-run --task <taskId> [--json]',
    'agent-os relay --from <sessionId> --to <toolId> [--json] [--data-dir <dir>]',
    'agent-os relay-targets --from <sessionId> [--json] [--data-dir <dir>]',
    '',
    'Examples:',
    '  agent-os agents --json',
    '  agent-os session-create --tool codex --workspace . --json',
    '  agent-os send --session 01H... --prompt "检查发布状态" --json',
    '  agent-os task-create --title 日报 --prompt "生成日报" --tool claude --at 2026-07-23T00:00:00Z --json',
    '  agent-os relay-targets --from 01H... --json',
    '  agent-os relay --from 01H... --to claude --json',
    '',
    'Installed desktop app:',
    '  "Agent OS.exe" --cli status --json',
    '  "/Applications/Agent OS.app/Contents/MacOS/Agent OS" --cli agents --json'
  ].join('\n')
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function textRelayResult(result: StartRelayResult): string {
  return (
    [
      '接力已创建',
      `targetSessionId: ${result.targetSessionId}`,
      `relayLinkId: ${result.relayLinkId}`,
      `openUrl: agentos://session/${result.targetSessionId}`
    ].join('\n') + '\n'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function textOrJson(value: unknown, json: boolean, text: string): string {
  return json ? jsonLine(value) : `${text}\n`
}

export function createAgentOsCli(deps: AgentOsCliDeps) {
  return {
    async run(args: string[]): Promise<CliResult> {
      const parsed = parseArgs(args)
      try {
        if (!parsed.command || parsed.help) {
          return { exitCode: 0, stdout: `${usage()}\n`, stderr: '' }
        }
        const runtime = deps.runtime
        if (parsed.command === 'status') {
          if (!runtime) throw new Error('当前 CLI Runtime 不可用')
          const status = await runtime.hostStatus()
          return {
            exitCode: 0,
            stdout: textOrJson(
              status,
              parsed.json,
              `Runtime: ${status.connection} · ${status.mode}`
            ),
            stderr: ''
          }
        }
        if (parsed.command === 'agents') {
          if (!runtime) throw new Error('当前 CLI Runtime 不可用')
          const agents = await runtime.listRuntimes()
          return {
            exitCode: 0,
            stdout: parsed.json
              ? jsonLine(agents)
              : `${agents.map((agent) => `${agent.toolId}\t${agent.health}\t${agent.displayName}`).join('\n')}${agents.length ? '\n' : ''}`,
            stderr: ''
          }
        }
        if (parsed.command === 'sessions') {
          if (!runtime) throw new Error('当前 CLI Runtime 不可用')
          const sessions = await runtime.listSessionViews()
          return {
            exitCode: 0,
            stdout: parsed.json
              ? jsonLine(sessions)
              : `${sessions.map((session) => `${session.id}\t${session.status}\t${session.toolId}\t${session.name}`).join('\n')}${sessions.length ? '\n' : ''}`,
            stderr: ''
          }
        }
        if (parsed.command === 'session-create') {
          if (!runtime) throw new Error('当前 CLI Runtime 不可用')
          if (!parsed.tool) throw new Error('缺少 --tool <toolId>')
          const workspacePath = parsed.workspace ? resolve(parsed.workspace) : process.cwd()
          const handle = await runtime.createSession({
            name: parsed.title?.trim() || `Agent OS CLI · ${parsed.tool}`,
            toolId: parsed.tool,
            workspacePath,
            surface: 'chat',
            permissionPreset: 'safe',
            ...(parsed.model ? { model: parsed.model } : {})
          })
          return {
            exitCode: 0,
            stdout: textOrJson(handle, parsed.json, `已创建会话 ${handle.session.id}`),
            stderr: ''
          }
        }
        if (parsed.command === 'send') {
          if (!runtime) throw new Error('当前 CLI Runtime 不可用')
          if (!parsed.session) throw new Error('缺少 --session <sessionId>')
          if (!parsed.prompt?.trim()) throw new Error('缺少 --prompt <text>')
          const state = await runtime.sendTurn(parsed.session, parsed.prompt)
          return {
            exitCode: 0,
            stdout: textOrJson(state, parsed.json, `消息已发送 · ${state.status}`),
            stderr: ''
          }
        }
        if (parsed.command === 'tasks') {
          if (!runtime) throw new Error('当前 CLI Runtime 不可用')
          const tasks = await runtime.listTasks()
          return {
            exitCode: 0,
            stdout: parsed.json
              ? jsonLine(tasks)
              : `${tasks.map((task) => `${task.id}\t${task.executionStatus}\t${task.title}`).join('\n')}${tasks.length ? '\n' : ''}`,
            stderr: ''
          }
        }
        if (parsed.command === 'task-create') {
          if (!runtime) throw new Error('当前 CLI Runtime 不可用')
          if (!parsed.title?.trim()) throw new Error('缺少 --title <title>')
          if (!parsed.prompt?.trim()) throw new Error('缺少 --prompt <text>')
          if (!parsed.tool) throw new Error('缺少 --tool <toolId>')
          let schedule: CreateTaskInput['schedule']
          if (parsed.at) {
            const at = new Date(parsed.at)
            if (!Number.isFinite(at.getTime())) throw new Error('--at 必须是有效 ISO 时间')
            schedule = {
              kind: 'once',
              runAt: at.toISOString(),
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              enabled: true,
              misfirePolicy: 'run_once'
            }
          }
          const task = await runtime.createTask({
            title: parsed.title,
            prompt: parsed.prompt,
            workspacePath: parsed.workspace ? resolve(parsed.workspace) : process.cwd(),
            assignee: { toolId: parsed.tool, ...(parsed.model ? { model: parsed.model } : {}) },
            boardStatus: 'todo',
            permissionPreset: 'safe',
            sessionPolicy: 'new',
            ...(schedule ? { schedule } : {})
          })
          return {
            exitCode: 0,
            stdout: textOrJson(task, parsed.json, `已创建任务 ${task.id}`),
            stderr: ''
          }
        }
        if (parsed.command === 'task-run') {
          if (!runtime) throw new Error('当前 CLI Runtime 不可用')
          if (!parsed.task) throw new Error('缺少 --task <taskId>')
          const run = await runtime.runTaskNow(parsed.task)
          return {
            exitCode: 0,
            stdout: textOrJson(run, parsed.json, `任务已排队 ${run.id}`),
            stderr: ''
          }
        }
        if (parsed.command === 'relay-targets') {
          if (!parsed.from) throw new Error('缺少 --from <sessionId>')
          const targets = await deps.listRelayTargets(parsed.from)
          return {
            exitCode: 0,
            stdout: parsed.json
              ? jsonLine(targets)
              : targets
                  .map(
                    (target) => `${target.toolId}\t${target.availability}\t${target.displayName}`
                  )
                  .join('\n') + '\n',
            stderr: ''
          }
        }
        if (parsed.command === 'relay') {
          if (!parsed.from) throw new Error('缺少 --from <sessionId>')
          if (!parsed.to) throw new Error('缺少 --to <toolId>')
          const result = await deps.startRelay({
            sourceSessionId: parsed.from,
            sourceSurface: 'cli',
            targetToolId: parsed.to
          })
          return {
            exitCode: 0,
            stdout: parsed.json
              ? jsonLine({
                  ok: true,
                  ...result,
                  openUrl: `agentos://session/${result.targetSessionId}`
                })
              : textRelayResult(result),
            stderr: ''
          }
        }
        throw new Error(`未知命令：${parsed.command}`)
      } catch (error) {
        return { exitCode: 1, stdout: '', stderr: `agent-os: ${errorMessage(error)}\n` }
      } finally {
        await deps.close()
      }
    }
  }
}

function defaultDataDir(): string {
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'agent-os')
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'agent-os')
  }
  return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'agent-os')
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(here, '../../package.json'), join(process.cwd(), 'package.json')]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string }
      if (parsed.version) return parsed.version
    } catch {
      // keep looking
    }
  }
  return '0.0.0'
}

async function runtimeForDataDir(dataDir: string): Promise<{
  runtime: RuntimeHost
  close(): Promise<void>
}> {
  const daemonConfigFile = join(dataDir, 'daemon.json')
  const daemon = readDaemonConfig(daemonConfigFile)
  if (daemon?.port && daemon.token) {
    try {
      const runtime = await DaemonRuntimeHost.connect({
        url: `ws://127.0.0.1:${daemon.port}`,
        token: daemon.token,
        expectedProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        timeoutMs: 1_500
      })
      return { runtime, close: () => runtime.close() }
    } catch {
      // Desktop may be closed or the daemon may be stale. Fall back to one-shot runtime.
    }
  }

  let bundle: DaemonRuntimeBundle | null = await createDaemonRuntime({
    token: randomBytes(32).toString('hex'),
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    hostVersion: packageVersion(),
    runtimeBuildId: 'agent-os-cli',
    sessionsFile: join(dataDir, 'runtime-sessions.json'),
    chatStoreFile: join(dataDir, 'chat-store.sqlite'),
    providerStoreFile: join(dataDir, 'agent-os.json')
  })
  return {
    runtime: bundle.runtime,
    close: async () => {
      bundle?.tasks.close()
      await bundle?.chat.close()
      bundle?.chatStore.close()
      bundle = null
    }
  }
}

export async function createRealAgentOsCli(
  dataDir = defaultDataDir()
): Promise<ReturnType<typeof createAgentOsCli>> {
  const runtimeBundle = await runtimeForDataDir(dataDir)
  const relay = new RelayService({
    runtime: runtimeBundle.runtime,
    getTranscript: async (): Promise<NormalizedTranscript | null> => null,
    openRepair: async () => undefined
  })
  return createAgentOsCli({
    startRelay: (payload) => relay.start(payload),
    listRelayTargets: (sourceSessionId) => relay.listTargets(sourceSessionId),
    runtime: runtimeBundle.runtime,
    close: () => runtimeBundle.close()
  })
}

/**
 * Electron 安装包不会把 package.json 的 npm `bin` 注册到用户 PATH。
 * 桌面可执行文件因此用显式 `--cli` 作为稳定、跨平台的无窗口入口。
 */
export function extractPackagedCliArgs(argv: string[]): string[] | null {
  const markerIndex = argv.indexOf('--cli')
  return markerIndex === -1 ? null : argv.slice(markerIndex + 1)
}

/** 运行真实 Runtime CLI；也覆盖 Runtime 初始化前的失败，统一返回可脚本化退出码。 */
export async function runRealAgentOsCli(args: string[]): Promise<CliResult> {
  const parsed = parseArgs(args)
  if (!parsed.command || parsed.help) {
    return { exitCode: 0, stdout: `${usage()}\n`, stderr: '' }
  }
  try {
    const cli = await createRealAgentOsCli(parsed.dataDir ?? defaultDataDir())
    return await cli.run(args)
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `agent-os: ${errorMessage(error)}\n` }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const result = await runRealAgentOsCli(args)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
}

if (process.argv[1] && existsSync(process.argv[1])) {
  const invoked = fileURLToPath(import.meta.url) === process.argv[1]
  if (invoked) void main()
}
