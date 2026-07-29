// 统一按钮基元（SPEC-005 v2 一致性）。变体/尺寸/loading；样式全用 tokens。

import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  type,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type ?? 'button'}
      className={`ui-btn ui-btn--${variant} ui-btn--${size}${loading ? ' is-loading' : ''}${
        className ? ` ${className}` : ''
      }`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className="ui-btn__spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}
