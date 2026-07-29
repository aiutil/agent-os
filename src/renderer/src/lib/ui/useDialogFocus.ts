// 弹窗焦点契约 hook（SPEC-021）。
// 提供给 lib/ui/Modal 与各自建 role=dialog 弹窗统一复用：
//   - 打开时聚焦首个可聚焦元素
//   - Tab/Shift+Tab 在容器内循环（焦点陷阱）
//   - Escape 触发 onEscape（capture 阶段拦截，避免与全局快捷键重复）
//   - 关闭/卸载时把焦点恢复到打开前的 activeElement（触发元素）
// 另导出 useScrollLock：弹窗打开期间锁定 body 滚动，防止背景滚动穿透。

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface DialogFocusOptions {
  /** Escape 时回调（通常为关闭）。不传则不响应 Escape。 */
  onEscape?: () => void
  /** 关闭后是否恢复焦点到打开前的元素，默认 true。 */
  restoreFocus?: boolean
}

export function useDialogFocus(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options?: DialogFocusOptions
): void {
  // 用 ref 承载回调，避免父组件内联函数导致 effect 反复重建（焦点丢失）。
  const optsRef = useRef(options)
  optsRef.current = options

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null
    const getFocusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))

    // 进入：聚焦首个可聚焦元素；无则让容器自身可聚焦（兜底）。
    const raf = requestAnimationFrame(() => {
      const first = getFocusables()[0]
      if (first) {
        first.focus()
      } else {
        container.setAttribute('tabindex', '-1')
        container.focus()
      }
    })

    const onKey = (event: KeyboardEvent): void => {
      const opts = optsRef.current
      if (event.key === 'Escape' && opts?.onEscape) {
        event.stopPropagation()
        opts.onEscape()
        return
      }
      if (event.key !== 'Tab') return
      const items = getFocusables()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const firstEl = items[0]
      const lastEl = items[items.length - 1]
      const current = document.activeElement
      if (event.shiftKey) {
        if (current === firstEl || !container.contains(current)) {
          event.preventDefault()
          lastEl.focus()
        }
      } else if (current === lastEl) {
        event.preventDefault()
        firstEl.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      if (optsRef.current?.restoreFocus !== false) {
        previouslyFocused?.focus?.()
      }
    }
    // active 与 containerRef 决定生命周期；回调经 ref 读取，不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, containerRef])
}

/** 弹窗打开期间锁定 body 滚动，关闭恢复原值。支持嵌套（计数式会过度复杂，此处简单保存/恢复）。 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [active])
}
