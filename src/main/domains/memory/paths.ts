import { homedir } from 'node:os'
import { join } from 'node:path'

/** 供 Electron、stdio MCP 与普通 Shell CLI 共同使用的本地记忆根目录。 */
export function memoryVaultPath(): string {
  const root = process.env['AGENT_OS_HOME']?.trim() || join(homedir(), '.agent-os')
  return join(root, 'memories', 'vault.sqlite')
}
