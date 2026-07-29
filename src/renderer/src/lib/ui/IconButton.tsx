// 统一图标按钮基元（关闭/返回/前进/更多等）。强制 aria-label，保证无障碍与一致尺寸。

import type { ButtonHTMLAttributes } from 'react'
import type { ButtonSize } from './Button'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: ButtonSize
}

export function IconButton({
  label,
  size = 'md',
  className,
  children,
  type,
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={`ui-iconbtn ui-iconbtn--${size}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}

/** 常用线性图标（currentColor，深浅色自动成立）。 */
export function CloseIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function BackIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M8 2.5L4 6.5l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
