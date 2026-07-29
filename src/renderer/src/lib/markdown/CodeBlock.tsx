// 代码块（SPEC-005 v2）。prism-react-renderer 仅做「分词」，颜色用 CSS 变量
// （tokens.css 的 --syntax-*），因此深浅色自动成立、不内联 prism 主题色。
// language 为 'diff' 时走 DiffBlock 行着色。

import { useState, useCallback } from 'react'
import { Highlight, Prism } from 'prism-react-renderer'
import { useT } from '../i18n'
import { parseDiff } from './diff'

// 空主题：不内联颜色，只让 getTokenProps 输出语义化 className（.token.keyword…）。
const PLAIN_THEME = { plain: {}, styles: [] }

/**
 * prism-react-renderer 未打包所有 Prism grammar。把未知语言交给 Highlight
 * 会在渲染期抛错，因此保留原语言标签，但按纯文本安全展示。
 */
export function resolveHighlightLanguage(language?: string): string {
  const normalized = language?.trim().toLowerCase()
  if (!normalized) return 'text'
  return Prism.languages[normalized] ? normalized : 'text'
}

function CopyButton({ code }: { code: string }): React.JSX.Element {
  const { t } = useT()
  const [status, setStatus] = useState<'idle' | 'done' | 'error'>('idle')
  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setStatus('done')
        setTimeout(() => setStatus('idle'), 1500)
      })
      .catch(() => setStatus('error'))
  }, [code])
  return (
    <button
      type="button"
      className={`md-code-copy${status === 'error' ? ' is-error' : ''}`}
      onClick={handleCopy}
    >
      <span aria-live="polite">
        {status === 'done'
          ? t('system.copy.done')
          : status === 'error'
            ? t('system.copy.failed')
            : t('common.action.copy')}
      </span>
    </button>
  )
}

export function DiffBlock({ code }: { code: string }): React.JSX.Element {
  const lines = parseDiff(code)
  return (
    <div className="md-code-wrap">
      <div className="md-code-header">
        <span className="md-code-lang">diff</span>
        <CopyButton code={code} />
      </div>
      <pre className="md-code md-diff" data-lang="diff">
        <code>
          {lines.map((line, i) => (
            <span key={i} className={`md-diff__line is-${line.kind}`}>
              {line.text || ' '}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}

export function CodeBlock({
  language,
  code
}: {
  language?: string
  code: string
}): React.JSX.Element {
  if (language === 'diff') return <DiffBlock code={code} />
  const highlightLanguage = resolveHighlightLanguage(language)
  return (
    <div className="md-code-wrap">
      <div className="md-code-header">
        {language ? <span className="md-code-lang">{language}</span> : <span />}
        <CopyButton code={code} />
      </div>
      <Highlight code={code} language={highlightLanguage} theme={PLAIN_THEME}>
        {({ tokens, getTokenProps }) => (
          <pre className="md-code" data-lang={language ?? ''}>
            <code>
              {tokens.map((line, i) => (
                <span key={i} className="md-code__line">
                  {line.map((token, k) => {
                    const props = getTokenProps({ token })
                    return (
                      <span key={k} className={props.className}>
                        {props.children}
                      </span>
                    )
                  })}
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  )
}
