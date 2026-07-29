// Web 镜头字典（SPEC-036）。Phase 2 由 web agent 填充。
// 含 pages/webagg/*、v3/sections/web/*、pages/overview/*、v3/shared/OriginBadge.tsx。

export const zh = {
  origin: {
    online: '运行于远程节点「{{label}}」',
    offline: '节点「{{label}}」已离线'
  },
  toolbar: {
    selectPrompt: '选择 Web AI'
  },
  login: {
    notLoggedIn: '未登录'
  },
  inject: {
    failedHint: '注入失败 · 需手动粘贴',
    noConfig: '无注入配置',
    failedColumns: { one: '，{{count}} 列注入失败', other: '，{{count}} 列注入失败' }
  },
  action: {
    reload: '重新加载'
  },
  empty: {
    title: 'Web 聚合',
    hint: '在上方选择一个或多个 Web AI，加载后在底部广播相同问题。',
    cookieHint: '每列独立登录，Cookie 互不串扰。注入失败时列右上角会有警示。'
  },
  broadcast: {
    ariaLabel: '广播消息',
    placeholder: '广播同一问题给所有选中的 Web AI…',
    button: '广播',
    buttonDoing: '广播中…',
    successCount: { one: '{{ok}}/{{total}} 列成功', other: '{{ok}}/{{total}} 列成功' }
  },
  bookmark: {
    manageTitle: '管理网站书签',
    namePlaceholder: '名称（可选）',
    empty: '还没有书签',
    currentHome: '当前首页',
    setHome: '设为首页',
    defaultHomeTitle: '默认首页'
  },
  secPanel: {
    quickAccess: '快速访问',
    pinned: '固定',
    frequent: '常用',
    addSite: '添加网站'
  },
  surface: {
    navBack: '后退',
    navForward: '前进',
    openExternal: '在浏览器中打开',
    loadFailed: '加载失败',
    failMessage: '页面加载失败。可重试或在浏览器中打开。',
    failMessageWithReason: '页面加载失败：{{reason}}。可重试或在浏览器中打开。'
  }
}

export const en: typeof zh = {
  origin: {
    online: 'Running on remote node “{{label}}”',
    offline: 'Node “{{label}}” is offline'
  },
  toolbar: {
    selectPrompt: 'Select Web AI'
  },
  login: {
    notLoggedIn: 'Not logged in'
  },
  inject: {
    failedHint: 'Injection failed · paste manually',
    noConfig: 'No injection config',
    failedColumns: { one: ', {{count}} column failed to inject', other: ', {{count}} columns failed to inject' }
  },
  action: {
    reload: 'Reload'
  },
  empty: {
    title: 'Web Aggregation',
    hint: 'Select one or more Web AIs above; once loaded, broadcast the same question at the bottom.',
    cookieHint: 'Each column logs in independently with isolated cookies. On injection failure, a warning shows at the column’s top-right.'
  },
  broadcast: {
    ariaLabel: 'Broadcast message',
    placeholder: 'Broadcast the same question to all selected Web AIs…',
    button: 'Broadcast',
    buttonDoing: 'Broadcasting…',
    successCount: { one: '{{ok}}/{{total}} column succeeded', other: '{{ok}}/{{total}} columns succeeded' }
  },
  bookmark: {
    manageTitle: 'Manage site bookmarks',
    namePlaceholder: 'Name (optional)',
    empty: 'No bookmarks yet',
    currentHome: 'Current home',
    setHome: 'Set as home',
    defaultHomeTitle: 'Default home'
  },
  secPanel: {
    quickAccess: 'Quick access',
    pinned: 'Pinned',
    frequent: 'Frequent',
    addSite: 'Add site'
  },
  surface: {
    navBack: 'Back',
    navForward: 'Forward',
    openExternal: 'Open in browser',
    loadFailed: 'Failed to load',
    failMessage: 'Page failed to load. Retry or open in browser.',
    failMessageWithReason: 'Page failed to load: {{reason}}. Retry or open in browser.'
  }
}
