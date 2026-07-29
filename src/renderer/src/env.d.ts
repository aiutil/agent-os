/**
 * 渲染端静态资源模块类型声明。
 *
 * tsconfig.web.json 的 types 仅含 ["node"]，未引入 vite/client，
 * 故在此显式声明 Vite 处理的图片资源导入（默认导出为构建后的 URL 字符串）。
 * 这让 `import logo from './x.png'` 在严格类型检查下可用。
 */
declare module '*.png' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}
