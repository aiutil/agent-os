// agent-os 远程节点（「agentos cli」入口，SPEC-032 反向模型）。
// 在另一台 LAN 主机上运行：装配本机 RuntimeHost（复用 createDaemonRuntime，自动发现本机 agent CLI），
// 主动拨回主控网关（wss + token，按指纹 pin 主控证书），暴露整套 RuntimeHost RPC 供主控驱动；断线自动重连。
//
// 初始化即「跑一个脚本」：node remote-node.js（或打包后的 agentos-node）。配置全走环境变量。

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, homedir } from 'node:os'
import { RUNTIME_PROTOCOL_VERSION, type NodePlatform } from '@shared/types'
import { createDaemonRuntime } from './domains/runtime/create-daemon-runtime'
import { startNodeGatewayClient } from './domains/runtime/node-gateway-client'
import { persistEnrolledNodeToken } from './domains/runtime/node-enrollment-token'
import type { DaemonConfig } from './domains/runtime/daemon-config'
import { enforceSecureTlsEnvironment } from './secure-tls-environment'

if (enforceSecureTlsEnvironment()) {
  console.warn('[security] 已移除 NODE_TLS_REJECT_UNAUTHORIZED=0；TLS 证书校验保持启用。企业 CA 请使用 NODE_EXTRA_CA_CERTS。')
}

function detectPlatform(): NodePlatform | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (process.platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (process.platform === 'linux')
    return arch === 'arm64' ? 'linux-arm64' : arch === 'x64' ? 'linux-x64' : undefined
  if (process.platform === 'win32' && arch === 'x64') return 'win-x64'
  return undefined
}

async function main(): Promise<void> {
  const dataDir = process.env.AGENT_OS_NODE_DATA || process.env.AGENT_OS_NODE_PREFIX || join(homedir(), '.agent-os-node')
  mkdirSync(dataDir, { recursive: true })

  const hostUrl = process.env.AGENT_OS_HOST
  const token = process.env.AGENT_OS_NODE_TOKEN
  const enrollmentToken = process.env.AGENT_OS_ENROLL_TOKEN
  if (!hostUrl || (!token && !enrollmentToken)) {
    console.error('✗ 缺少 AGENT_OS_HOST 或节点/enrollment token（请用主控生成的安装命令运行）')
    process.exit(1)
  }
  const hostFingerprint = process.env.AGENT_OS_HOST_FP
  const label = process.env.AGENT_OS_NODE_LABEL || hostname()
  const statusFile = join(dataDir, 'node-status.json')
  let adopted: { nodeId: string; adoptedAt: string } | undefined

  const persistStatus = (state: 'connecting' | 'connected' | 'disconnected', error?: Error): void => {
    const temporary = `${statusFile}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({
      schemaVersion: 1,
      state,
      host: hostUrl,
      hostVersion: process.env.AGENT_OS_NODE_VERSION || '0.0.0',
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      ...(adopted ?? {}),
      ...(error ? { error: error.message } : {})
    }, null, 2), { mode: 0o600 })
    renameSync(temporary, statusFile)
  }

  const config: DaemonConfig = {
    token: token || enrollmentToken!,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    hostVersion: process.env.AGENT_OS_NODE_VERSION || '0.0.0',
    runtimeBuildId: '',
    sessionsFile: join(dataDir, 'sessions.json'),
    chatStoreFile: join(dataDir, 'chat-store.sqlite'),
    providerStoreFile: join(dataDir, 'providers.json')
  }

  const { runtime, chat, chatStore, tasks, runtimeBuildId } = await createDaemonRuntime(config)

  const client = startNodeGatewayClient({
    url: hostUrl,
    token,
    enrollmentToken,
    onEnrollmentAccepted: (acceptedToken) => {
      const prefix = process.env.AGENT_OS_NODE_PREFIX || dataDir
      persistEnrolledNodeToken(join(prefix, 'node.env'), acceptedToken)
      process.env.AGENT_OS_NODE_TOKEN = acceptedToken
      delete process.env.AGENT_OS_ENROLL_TOKEN
    },
    hostFingerprint,
    rpc: {
      runtime,
      hostVersion: config.hostVersion,
      runtimeBuildId,
      protocolVersion: config.protocolVersion,
      pid: process.pid,
      startedAt: new Date().toISOString()
    },
    register: {
      label,
      platform: detectPlatform(),
      hostVersion: config.hostVersion,
      protocolVersion: config.protocolVersion
    },
    onAdopted: (acknowledgement) => {
      adopted = {
        nodeId: acknowledgement.nodeId,
        adoptedAt: acknowledgement.adoptedAt
      }
      persistStatus('connected')
    },
    onStateChange: (state, error) => {
      if (state !== 'connected') {
        adopted = undefined
        try {
          persistStatus(state, error)
        } catch (statusError) {
          console.error('[node] 无法写入本地状态文件', statusError)
        }
      }
      const suffix = error ? `（${error.message}）` : ''
      console.log(`[node] ${state} → ${hostUrl}${suffix}`)
    }
  })

  const shutdown = (): void => {
    client.close()
    tasks.close()
    void Promise.all([chat.close()]).finally(() => {
      chatStore.close()
      process.exit(0)
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
