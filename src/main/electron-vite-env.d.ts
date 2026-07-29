/// <reference types="electron-vite/node" />

/** 构建时内嵌的 Agent-OS commit；未提交工作树带 `-dirty`。 */
declare const __AGENT_OS_SOURCE_REVISION__: string

/** 由 .env / CI 环境在构建期注入；开发 token 缺失时埋点硬关闭。 */
declare const __MIXPANEL_PRODUCTION_TOKEN__: string
declare const __MIXPANEL_DEVELOPMENT_TOKEN__: string
