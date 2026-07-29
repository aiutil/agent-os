// 会话详情 Markdown 渲染（SPEC-005 v2 质感）。
// react-markdown + remark-gfm；默认不渲染原始 HTML（无 rehype-raw）即安全。
// 代码块此版用 token 样式的 <pre>；语法高亮/diff 着色在 A2 增强。

import { Component, type ErrorInfo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useT } from '../i18n'
import { CodeBlock } from './CodeBlock'
import './markdown.css'

function openExternal(href?: string): void {
  if (href && /^https?:\/\//i.test(href)) void window.agentOs.app.openExternal(href)
}

/** 流式回复可能暂时缺少围栏结尾；补齐仅用于本次渲染，不修改消息原文。 */
export function normalizeStreamingMarkdown(content: string): string {
  let openFence = ''
  for (const line of content.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue
    const marker = match[1]
    if (!openFence) {
      openFence = marker
    } else if (
      marker[0] === openFence[0] &&
      marker.length >= openFence.length &&
      match[2].trim() === ''
    ) {
      openFence = ''
    }
  }
  if (!openFence) return content
  return `${content}${content.endsWith('\n') ? '' : '\n'}${openFence}`
}

interface MarkdownRenderBoundaryProps {
  content: string
  children: ReactNode
}

class MarkdownRenderBoundary extends Component<MarkdownRenderBoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      '[markdown] render failed; falling back to plain text',
      error,
      info.componentStack
    )
  }

  override componentDidUpdate(previous: MarkdownRenderBoundaryProps): void {
    if (this.state.failed && previous.content !== this.props.content) {
      this.setState({ failed: false })
    }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <pre className="md-fallback">{this.props.content}</pre>
    }
    return this.props.children
  }
}

export function Markdown({
  content,
  preserveSoftBreaks = false
}: {
  content: string
  preserveSoftBreaks?: boolean
}): React.JSX.Element {
  const { t } = useT()
  const renderContent = normalizeStreamingMarkdown(content)
  return (
    <div className={`md${preserveSoftBreaks ? ' md--preserve-soft-breaks' : ''}`}>
      <MarkdownRenderBoundary content={content}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // 受控外链：交系统浏览器打开，避免渲染进程被导航劫持。
            a({ href, children }) {
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault()
                    openExternal(href)
                  }}
                >
                  {children}
                </a>
              )
            },
            // 把围栏代码交给 CodeBlock 自渲染 <pre>；此处 pre 透传避免 <pre><pre> 嵌套。
            pre({ children }) {
              return <>{children}</>
            },
            // GFM 表格：外层可滚动 wrapper，宽表横向滚动而不撑破容器。
            table({ children }) {
              return (
                <div
                  className="md-table-scroll"
                  role="group"
                  tabIndex={0}
                  aria-label={t('system.table.label')}
                >
                  <table>{children}</table>
                </div>
              )
            },
            code({ className, children }) {
              const match = /language-([^\s]+)/.exec(className || '')
              const text = String(children ?? '')
              const isBlock = Boolean(match) || text.includes('\n')
              if (isBlock) {
                return <CodeBlock language={match?.[1]} code={text.replace(/\n$/, '')} />
              }
              return <code className="md-inline">{children}</code>
            }
          }}
        >
          {renderContent}
        </ReactMarkdown>
      </MarkdownRenderBoundary>
    </div>
  )
}
