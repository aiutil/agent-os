import { homedir } from 'node:os'
import { join } from 'node:path'

export function knowledgeRootPath(): string {
  const root = process.env['AGENT_OS_HOME']?.trim() || join(homedir(), '.agent-os')
  return join(root, 'knowledge')
}
