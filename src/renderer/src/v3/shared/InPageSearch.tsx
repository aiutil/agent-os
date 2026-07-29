// 会话内 Ctrl+F 原地搜索浮层：输入 + N/M 计数 + 上一个/下一个 + 关闭。
// Enter=下一个，Shift+Enter=上一个，↑/下=导航，Esc=关闭。
// 位置：消息区右上角悬浮（由父容器 position:relative 定位）。

import { useEffect, useRef } from 'react'
import { useT } from '../../lib/i18n'

export function InPageSearch({
  query,
  onQueryChange,
  count,
  index,
  onGoTo,
  onClose
}: {
  query: string
  onQueryChange(value: string): void
  count: number
  index: number
  onGoTo(idx: number): void
  onClose(): void
}): React.JSX.Element {
  const { t } = useT()
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onGoTo(event.shiftKey ? index - 1 : index + 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      onGoTo(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      onGoTo(index - 1)
    }
  }
  return (
    <div className="inpage-search" role="search">
      <input
        ref={inputRef}
        className="inpage-search__input"
        value={query}
        placeholder={t('chat.find.placeholder')}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="inpage-search__count">
        {count > 0 ? `${index + 1}/${count}` : query ? '0/0' : ''}
      </span>
      <button
        type="button"
        className="inpage-search__btn"
        onClick={() => onGoTo(index - 1)}
        disabled={count === 0}
        title={t('chat.find.prev')}
        aria-label={t('chat.find.prev')}
      >
        ↑
      </button>
      <button
        type="button"
        className="inpage-search__btn"
        onClick={() => onGoTo(index + 1)}
        disabled={count === 0}
        title={t('chat.find.next')}
        aria-label={t('chat.find.next')}
      >
        ↓
      </button>
      <button
        type="button"
        className="inpage-search__close"
        onClick={onClose}
        title={t('common.action.close')}
        aria-label={t('common.action.close')}
      >
        ×
      </button>
    </div>
  )
}
