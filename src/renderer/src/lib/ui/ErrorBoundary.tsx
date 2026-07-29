// 根级错误边界（SPEC-021）。任意子树渲染期抛错即展示可读错误态 + 重试，避免整树白屏。
// 仅记录到控制台、不外发；fallback 复用 global.css 的 .empty-state/.btn 基元，全走 token。

import { Component, type ReactNode } from 'react'
import { tr } from '@shared/i18n'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error): void {
    console.error('[Agent OS] 渲染错误：', error)
  }

  handleReset = (): void => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app-shell">
          <div className="empty-state" role="alert" aria-live="assertive">
            <div className="empty-state__title">{tr('system.errorBoundary.title')}</div>
            <div className="empty-state__hint">
              {this.state.error.message || tr('system.errorBoundary.fallback')}
            </div>
            <button type="button" className="btn btn--ghost" onClick={this.handleReset}>
              {tr('common.action.retry')}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
