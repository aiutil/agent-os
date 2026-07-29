/** CLI 产品展示名的单一注册表；adapter、设置页、选择器和图标无障碍标签共用。 */
export const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  hermes: 'Hermes Agent',
  openclaw: 'OpenClaw',
  pi: 'Pi',
  'cursor-agent': 'Cursor Agent',
  shell: 'Shell',
  github: 'GitHub'
}

export function toolDisplayName(toolId: string): string {
  return TOOL_DISPLAY_NAMES[toolId] ?? toolId
}
