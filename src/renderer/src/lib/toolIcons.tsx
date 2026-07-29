/**
 * Tool Icon Registry（agent-os）
 * 品牌图标用 @lobehub/icons Mono；通用 UI 图标用 @icon-park/react。
 * 渲染配置：theme="outline" strokeWidth={3} fill={['none']}（干净线性风，参考 Claude 客户端）。
 */

import type { FC, SVGProps } from 'react'
import { tr } from '@shared/i18n'
import { toolDisplayName } from '@shared/tool-display'
import ClaudeCodeBrand from '@lobehub/icons/es/ClaudeCode/components/Mono'
import CodexBrand from '@lobehub/icons/es/Codex/components/Mono'
import GeminiBrand from '@lobehub/icons/es/Gemini/components/Mono'
import OpenCodeBrand from '@lobehub/icons/es/OpenCode/components/Mono'
import GithubBrand from '@lobehub/icons/es/Github/components/Mono'
import CursorBrand from '@lobehub/icons/es/Cursor/components/Mono'
import HermesAgentBrand from '@lobehub/icons/es/HermesAgent/components/Mono'
import OpenClawBrand from '@lobehub/icons/es/OpenClaw/components/Mono'
import PiBrand from '../icons/PiBrand'
import {
  Code,
  Terminal,
  Globe,
  Search,
  Setting,
  Analysis,
  Memory,
  Brain,
  Server
} from '@icon-park/react'

type IconComponent = FC<SVGProps<SVGSVGElement> & { size?: number | string }>

interface IconEntry {
  component: IconComponent
  label: string
  source: 'lobe' | 'iconpark'
}

// 品牌色一律引用 tokens.css 的 --tool-* 变量（深浅主题各自适配），避免硬编码 hex。
// github 无对应 token，缺省时回退 currentColor（继承文字色）。
const BRAND_COLORS: Record<string, string> = {
  claude: 'var(--tool-claude)',
  codex: 'var(--tool-codex)',
  gemini: 'var(--tool-gemini)',
  hermes: 'var(--tool-hermes)',
  openclaw: 'var(--tool-openclaw)',
  opencode: 'var(--tool-opencode)',
  pi: 'var(--tool-pi)'
}

const BRAND_REGISTRY: Record<string, IconEntry> = {
  claude:         { component: ClaudeCodeBrand as IconComponent,  label: toolDisplayName('claude'),       source: 'lobe' },
  codex:          { component: CodexBrand as IconComponent,       label: toolDisplayName('codex'),        source: 'lobe' },
  gemini:         { component: GeminiBrand as IconComponent,      label: toolDisplayName('gemini'),       source: 'lobe' },
  opencode:       { component: OpenCodeBrand as IconComponent,    label: toolDisplayName('opencode'),     source: 'lobe' },
  github:         { component: GithubBrand as IconComponent,      label: toolDisplayName('github'),       source: 'lobe' },
  'cursor-agent': { component: CursorBrand as IconComponent,      label: toolDisplayName('cursor-agent'), source: 'lobe' },
  hermes:         { component: HermesAgentBrand as IconComponent, label: toolDisplayName('hermes'),       source: 'lobe' },
  openclaw:       { component: OpenClawBrand as IconComponent,    label: toolDisplayName('openclaw'),     source: 'lobe' },
  pi:             { component: PiBrand as IconComponent,          label: toolDisplayName('pi'),           source: 'lobe' }
}

const GENERIC_REGISTRY: Record<string, IconEntry> = {
  terminal: { component: Terminal as IconComponent, label: tr('system.toolIcon.terminal'), source: 'iconpark' },
  globe:    { component: Globe as IconComponent,    label: 'Web',                          source: 'iconpark' },
  search:   { component: Search as IconComponent,   label: tr('common.action.search'),     source: 'iconpark' },
  settings: { component: Setting as IconComponent,  label: tr('common.label.settings'),    source: 'iconpark' },
  analysis: { component: Analysis as IconComponent, label: tr('system.toolIcon.analysis'), source: 'iconpark' },
  memory:   { component: Memory as IconComponent,   label: tr('system.toolIcon.memory'),   source: 'iconpark' },
  brain:    { component: Brain as IconComponent,    label: tr('system.toolIcon.brain'),    source: 'iconpark' },
  code:     { component: Code as IconComponent,     label: tr('system.toolIcon.code'),     source: 'iconpark' }
}

function resolveIcon(toolId: string): IconEntry | null {
  return BRAND_REGISTRY[toolId] ?? GENERIC_REGISTRY[toolId] ?? null
}

export interface ToolIconProps {
  toolId: string
  size?: number
  brandColor?: boolean
  className?: string
}

type IconParkProps = { theme: string; size: number; strokeWidth: number; fill?: string[] }

/** 渲染工具图标；无注册图标时降级为首字母头像。 */
export function ToolIcon({ toolId, size = 14, brandColor, className }: ToolIconProps): React.JSX.Element {
  const entry = resolveIcon(toolId)

  if (!entry) {
    const letter = toolId.trim().charAt(0).toUpperCase() || '?'
    const color = brandColor ? (BRAND_COLORS[toolId] ?? 'var(--tool-generic)') : 'var(--text-secondary)'
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: brandColor ? 'color-mix(in oklch, var(--tool-generic) 13%, var(--bg-card))' : 'var(--bg-active)',
          color,
          fontSize: Math.max(size * 0.6, 8),
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          lineHeight: 1,
          fontFamily: 'inherit',
          userSelect: 'none'
        }}
        className={className}
      >
        {letter}
      </span>
    )
  }

  const Component = entry.component
  if (entry.source === 'lobe') {
    const color = brandColor ? (BRAND_COLORS[toolId] ?? undefined) : undefined
    return <Component size={size} style={color ? { color } : undefined} className={className} />
  }

  const IpComp = Component as FC<IconParkProps & { className?: string }>
  return (
    <IpComp
      theme="outline"
      size={size}
      strokeWidth={3}
      fill={['none']}
      className={className}
    />
  )
}

/** 渲染 @icon-park/react 通用图标（统一渲染参数）。 */
export function IpIcon({
  icon: Icon,
  size = 14,
  className
}: {
  icon: FC<IconParkProps & { className?: string }>
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <Icon
      theme="outline"
      size={size}
      strokeWidth={3}
      fill={['none']}
      className={className}
    />
  )
}

/** 远程联邦节点图标（节点 section header / 来源徽标用）。 */
export function NodeIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <Server theme="outline" size={size} strokeWidth={3} fill={['none']} className={className} />
  )
}

export { BRAND_COLORS, BRAND_REGISTRY }
