import { readDaemonConfig, writeDaemonConfig } from './domains/runtime/daemon-config'
import { startRuntimeDaemonServer } from './domains/runtime/daemon-server'
import { createDaemonRuntime } from './domains/runtime/create-daemon-runtime'
import { enforceSecureTlsEnvironment } from './secure-tls-environment'

if (enforceSecureTlsEnvironment()) {
  console.warn('[security] 已移除 NODE_TLS_REJECT_UNAUTHORIZED=0；TLS 证书校验保持启用。企业 CA 请使用 NODE_EXTRA_CA_CERTS。')
}

async function main(): Promise<void> {
  const configFile = process.env.AGENT_OS_DAEMON_CONFIG
  if (!configFile) throw new Error('缺少 AGENT_OS_DAEMON_CONFIG')
  const config = readDaemonConfig(configFile)
  if (!config) throw new Error('daemon 配置无效')

  const { runtime, chat, chatStore, tasks, runtimeBuildId } = await createDaemonRuntime(config)
  const startedAt = new Date().toISOString()
  const server = await startRuntimeDaemonServer({
    runtime,
    token: config.token,
    hostVersion: config.hostVersion,
    runtimeBuildId,
    protocolVersion: config.protocolVersion,
    host: '127.0.0.1',
    port: 0,
    pid: process.pid,
    startedAt
  })
  writeDaemonConfig(configFile, {
    ...config,
    runtimeBuildId,
    pid: process.pid,
    port: server.port,
    startedAt
  })

  const shutdown = (): void => {
    tasks.close()
    void Promise.all([server.close(), chat.close()]).finally(() => {
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
