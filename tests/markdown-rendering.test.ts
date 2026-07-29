import { createElement, StrictMode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { resolveHighlightLanguage } from '../src/renderer/src/lib/markdown/CodeBlock'
import { Markdown, normalizeStreamingMarkdown } from '../src/renderer/src/lib/markdown/Markdown'

describe('会话 Markdown 可靠渲染', () => {
  it('在 StrictMode 下渲染 GFM 内容', () => {
    const content = '# 结果\n\n- [x] 完成\n\n| 项目 | 状态 |\n| --- | --- |\n| Agent | 正常 |'
    const html = renderToStaticMarkup(
      createElement(StrictMode, null, createElement(Markdown, { content }))
    )
    expect(html).toContain('<h1>结果</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
  })

  it('未知代码语言降级为纯文本且保留语言标签', () => {
    expect(resolveHighlightLanguage('mermaid')).toBe('text')
    expect(resolveHighlightLanguage('totally-unknown')).toBe('text')

    const html = renderToStaticMarkup(
      createElement(Markdown, { content: '```mermaid\ngraph TD; A-->B\n```' })
    )
    expect(html).toContain('mermaid')
    expect(html).toContain('graph TD; A--&gt;B')
  })

  it('流式未闭合围栏仅在渲染副本中补齐', () => {
    const original = '执行结果：\n```bash\necho ready'
    expect(normalizeStreamingMarkdown(original)).toBe(`${original}\n\`\`\``)

    const html = renderToStaticMarkup(createElement(Markdown, { content: original }))
    expect(html).toContain('echo ready')
    expect(html).toContain('bash')
  })

  it('用户消息可显式保留 CommonMark soft break，而默认模式不受影响', () => {
    const content = '第一行\n第二行'
    const defaultHtml = renderToStaticMarkup(createElement(Markdown, { content }))
    const preservingHtml = renderToStaticMarkup(
      createElement(Markdown, { content, preserveSoftBreaks: true })
    )

    expect(defaultHtml).toContain('class="md"')
    expect(defaultHtml).not.toContain('md--preserve-soft-breaks')
    expect(preservingHtml).toContain('class="md md--preserve-soft-breaks"')
    expect(preservingHtml).toContain('第一行\n第二行')
  })
})
