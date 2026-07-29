import type { WorkbenchSession } from '@shared/types'
import { deriveSessionDisplayTitle, sanitizeTranscriptTitle } from '@shared/transcript/title'
import { tr } from '@shared/i18n'

function workspaceBase(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * Renderer 单一会话标题投影。
 * 所有会话/CLI 列表、页头、标签和归档入口都应调用这里，避免各自清洗 raw name。
 */
export function sessionDisplayTitle(
  session: Pick<WorkbenchSession, 'name' | 'workspacePath' | 'surface' | 'chatHistory'>,
  preferredName?: string | null
): string {
  const firstUserText = session.chatHistory
    ?.filter((message) => message.role === 'user')
    .map((message) => sanitizeTranscriptTitle(message.text, 80))
    .find(Boolean)
  return deriveSessionDisplayTitle({
    name: preferredName ?? session.name,
    workspaceBase: workspaceBase(session.workspacePath),
    firstUserText,
    fallback:
      session.surface === 'terminal'
        ? tr('chat.session.unnamedCli')
        : tr('chat.session.unnamedChat')
  })
}
