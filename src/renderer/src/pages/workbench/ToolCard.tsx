// 工具调用卡片（SPEC-005 v2，对照 session.html）。
// 线性图标 + 路径 + 状态徽标 + Edit diff 统计；结果按 diff/代码渲染，可折叠。

import type { ChatItem } from './chat-model'
import { CodeBlock, DiffBlock } from '../../lib/markdown/CodeBlock'
import { isUnifiedDiff, parseDiff, diffStats } from '../../lib/markdown/diff'
import { useT } from '../../lib/i18n'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// 干净线性图标（currentColor，深浅色自动成立）。
function ToolGlyph({ kind }: { kind: string }): React.JSX.Element {
  const common = { width: 13, height: 13, viewBox: '0 0 14 14', fill: 'none' as const, 'aria-hidden': true }
  const stroke = { stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (kind === 'edit' || kind === 'write') {
    return (
      <svg {...common}>
        <path d="M9 2.5l2.5 2.5L5 11.5H2.5V9L9 2.5Z" {...stroke} />
      </svg>
    )
  }
  if (kind === 'bash') {
    return (
      <svg {...common}>
        <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" {...stroke} />
        <path d="M4 6l1.8 1.5L4 9M7.5 9.2h3" {...stroke} />
      </svg>
    )
  }
  if (kind === 'search') {
    return (
      <svg {...common}>
        <circle cx="6" cy="6" r="3.5" {...stroke} />
        <path d="M8.8 8.8L12 12" {...stroke} />
      </svg>
    )
  }
  if (kind === 'read') {
    return (
      <svg {...common}>
        <path d="M3 2h5l3 3v7H3V2Z" {...stroke} />
        <path d="M8 2v3h3M5 8h4M5 10h3" {...stroke} />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="7" cy="7" r="5" {...stroke} />
      <path d="M7 4.5v3l2 1" {...stroke} />
    </svg>
  )
}

function glyphKind(toolName: string): string {
  const n = toolName.toLowerCase()
  if (n.includes('edit') || n.includes('multiedit')) return 'edit'
  if (n.includes('write') || n.includes('notebook')) return 'write'
  if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('command')) return 'bash'
  if (n.includes('grep') || n.includes('glob') || n.includes('search') || n.includes('find')) return 'search'
  if (n.includes('read') || n.includes('cat') || n.includes('view')) return 'read'
  return 'generic'
}

function pathOf(input: unknown): string | undefined {
  if (input == null || typeof input !== 'object') return undefined
  const r = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'url', 'query']) {
    const v = r[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

export function ToolCard({ item }: { item: ToolItem }): React.JSX.Element {
  const { t } = useT()
  const kind = glyphKind(item.toolName)
  const path = pathOf(item.input)
  const running = item.result === undefined
  const status = running ? t('workbench.tool.status.running') : item.isError ? t('workbench.tool.status.failed') : t('workbench.tool.status.done')
  const resultIsDiff = !running && !item.isError && typeof item.result === 'string' && isUnifiedDiff(item.result)
  const stats = resultIsDiff ? diffStats(parseDiff(item.result as string)) : null

  return (
    <details className={`chat-tool ${item.isError ? 'is-error' : ''}`} open={resultIsDiff}>
      <summary className="chat-tool__head">
        <span className={`chat-tool__glyph is-${kind}`}>
          <ToolGlyph kind={kind} />
        </span>
        <span className="chat-tool__name">{item.toolName}</span>
        {path && <span className="chat-tool__path mono">{path}</span>}
        {stats && (
          <span className="chat-tool__diffstat">
            <span className="chat-tool__add">+{stats.added}</span>
            <span className="chat-tool__del">−{stats.deleted}</span>
          </span>
        )}
        <span className={`chat-tool__status is-${running ? 'running' : item.isError ? 'error' : 'ok'}`}>
          {running && <span className="chat-tool__spinner" />}
          {status}
        </span>
        <span className="chat-tool__chevron" aria-hidden="true" />
      </summary>
      <div className="chat-tool__body">
        {item.result !== undefined &&
          (resultIsDiff ? (
            <DiffBlock code={item.result as string} />
          ) : (
            <CodeBlock code={String(item.result)} />
          ))}
      </div>
    </details>
  )
}
