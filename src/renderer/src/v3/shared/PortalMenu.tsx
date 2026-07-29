// 通过 portal 渲染的下拉菜单，定位基于锚点按钮，避免被父级 overflow:hidden 裁切。

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export function PortalMenu({
  anchorRef,
  open,
  onClose,
  width = 200,
  placement = 'down',
  align = 'left',
  animateEnter = false,
  children
}: {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose(): void
  width?: number
  placement?: 'up' | 'down'
  align?: 'left' | 'right'
  /** 进入动画（opacity+轻位移）；默认关，保持 ToolSelector/ModelPicker 逐字节不变。 */
  animateEnter?: boolean
  children: React.ReactNode
}): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties | null>(null)
  const [resolved, setResolved] = useState<'up' | 'down'>(placement)

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const r = anchorRef.current.getBoundingClientRect()
    // 视口自适应：首选方向空间不足且对侧更宽裕时翻转，避免贴近屏幕边缘被裁切。
    const spaceUp = r.top
    const spaceDown = window.innerHeight - r.bottom
    let effective: 'up' | 'down' = placement
    if (placement === 'up' && spaceUp < 220 && spaceDown > spaceUp + 80) effective = 'down'
    else if (placement === 'down' && spaceDown < 220 && spaceUp > spaceDown + 80) effective = 'up'
    setResolved(effective)
    // 边界自适应：菜单宽度不超过视口（留 16px 边距，下限 160）；左对齐时若右溢出则整体左移避让，
    // 不贴出左边界；右对齐沿用 max(8) 保护。正常（不溢出）时与原定位完全一致。
    const maxMenuW = Math.max(160, window.innerWidth - 16)
    const menuW = Math.min(width, maxMenuW)
    const base: React.CSSProperties = {
      position: 'fixed',
      width: menuW,
      zIndex: 1000,
      ...(align === 'right'
        ? { left: Math.max(8, r.right - menuW) }
        : { left: Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8)) }),
      ...(effective === 'up' ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 })
    }
    setStyle(base)
  }, [open, anchorRef, width, placement, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if ((e.target as Element | null)?.closest('.portal-menu')) return
      if (menuRef.current?.contains(e.target as Node)) return
      if (anchorRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, anchorRef, onClose])

  if (!open || !style) return null
  return createPortal(
    <div
      ref={menuRef}
      data-placement={resolved}
      className={animateEnter ? 'portal-menu portal-menu--anim' : 'portal-menu'}
      style={{
        ...style,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-medium)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(24,24,27,.16)',
        padding: 4
      }}
    >
      {children}
    </div>,
    document.body
  )
}
