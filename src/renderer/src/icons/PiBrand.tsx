/**
 * Pi（@earendil-works/pi-coding-agent）品牌图标 —— 单色，随 currentColor 着色。
 *
 * 与 @lobehub/icons Mono 组件保持同一渲染契约（size/style/className），
 * 以便 src/renderer/src/lib/toolIcons.tsx 的 BRAND_REGISTRY 统一着色。
 * 原始素材取自 public/pi-coding-agent.svg 的 pi 字形（P + i 点）；
 * 原 svg 为白底透明，此处改为 fill="currentColor" 以适配深浅主题与品牌色。
 */
import type { FC, SVGProps } from 'react'

const PiBrand: FC<SVGProps<SVGSVGElement> & { size?: number | string }> = ({
  size = '1em',
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 800 800"
    width={size}
    height={size}
    fill="currentColor"
    aria-hidden="true"
    {...props}
  >
    {/* P 字形：外环顺时针 + 内孔逆时针（evenodd 形成镂空） */}
    <path
      fillRule="evenodd"
      d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
    />
    {/* i 点 */}
    <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
  </svg>
)

export default PiBrand
