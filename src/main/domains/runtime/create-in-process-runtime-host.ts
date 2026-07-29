import { randomUUID } from 'node:crypto'
import { getAdapter } from '../adapters/registry'
import { scanAll, scanOne } from '../discovery/discovery'
import { listToolModels } from '../discovery/models'
import { nativeSessionExists, observeNativeSession } from '../sessions/native-session-binding'
import { filterUsableDiscoveryResults } from '@shared/runtime-availability'
import type { TerminalManager } from '../terminal/manager'
import { InProcessRuntimeHost } from './in-process-runtime-host'
import type { RuntimeChat, RuntimeSessionRepository, RuntimeTasks } from './protocol'

export function createInProcessRuntimeHost(
  terminal: TerminalManager,
  hostVersion: string,
  sessions: RuntimeSessionRepository,
  chat: RuntimeChat,
  provider: {
    environment(toolId: string): Record<string, string>
    model(toolId: string): string | undefined
  },
  runtimeBuildId = hostVersion,
  tasks?: RuntimeTasks
): InProcessRuntimeHost {
  return new InProcessRuntimeHost({
    terminal,
    chat,
    sessions,
    getAdapter,
    listRuntimes: async () =>
      filterUsableDiscoveryResults(await scanAll()).map((result) => ({
        toolId: result.toolId,
        displayName: result.displayName,
        channel: 'pty',
        canResume: Boolean(getAdapter(result.toolId)?.buildResumeCommand),
        capabilities: {
          terminal: true,
          chat: Boolean(getAdapter(result.toolId)?.headlessJson),
          terminalResume: Boolean(getAdapter(result.toolId)?.buildResumeCommand),
          chatContinuation: getAdapter(result.toolId)?.headlessJson
            ? getAdapter(result.toolId)?.headlessJson?.supportsNativeResume
              ? 'native'
              : 'managed-history'
            : 'none',
          linkedTerminal: Boolean(
            getAdapter(result.toolId)?.headlessJson && getAdapter(result.toolId)?.buildResumeCommand
          ),
          attachments: getAdapter(result.toolId)?.headlessJson?.attachments ?? {
            images: false,
            files: false
          }
        },
        health: result.health,
        ...(result.version ? { version: result.version } : {}),
        ...(result.executablePath ? { executablePath: result.executablePath } : {})
      })),
    // SPEC-033：模型发现与本机 IPC 保持一致（scanOne 取真实二进制再列模型）。
    listModels: async (toolId: string) => {
      const found = await scanOne(toolId)
      return listToolModels(toolId, found?.executablePath)
    },
    observeNativeSession,
    nativeSessionExists,
    createNativeSessionId: randomUUID,
    getProviderEnv: (toolId) => provider.environment(toolId),
    getProviderModel: (toolId) => provider.model(toolId),
    hostVersion,
    runtimeBuildId,
    tasks
  })
}
