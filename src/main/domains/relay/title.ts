export function relayTitle(sourceTitle: string, targetDisplayName: string, rootTitle?: string): string {
  const base = (rootTitle || sourceTitle).replace(/\s*\/\s*[^/]+接力\s*$/u, '').trim()
  return `${base || sourceTitle || '新会话'} / ${targetDisplayName} 接力`
}
