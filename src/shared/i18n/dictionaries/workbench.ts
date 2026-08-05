// 工作台字典（SPEC-036）。含 V3App/Shell/Dock/WorkbenchMain/ChatPane/SessionCard/
// SessionRail/ToolCard/WorkbenchPage/WorkspaceTabBar/terminalRegistry/lib/time/lib/status 等。
// zh 为 schema 源，en 按 typeof zh 同形约束（缺键/异形即编译错误）。

export const zh = {
  section: {
    chat: '会话',
    board: '看板',
    schedule: '定时',
    compare: '对比',
    memory: '存储',
    web: 'Web',
    stats: '统计'
  },
  nav: {
    compare: '对比',
    memory: '记忆',
    stats: '统计'
  },
  mode: {
    chat: '会话',
    cli: 'CLI',
    chatHint: '结构化对话镜头',
    cliHint: 'CLI 终端镜头',
    newChat: '新对话',
    newCli: '新 CLI'
  },
  rail: {
    sectionTerminal: '终端',
    sectionSession: '会话',
    aria: '工作台会话',
    filterSessions: '筛选会话',
    clear: '清除',
    clearTagFilter: '清除标签筛选',
    unnamedProject: '未命名项目',
    emptyTerminal: '暂无终端',
    emptySession: '暂无会话',
    openTerminal: '打开终端',
    newSession: '新建会话',
    selectAsWorkdir: '选为新建会话的工作目录',
    filter: {
      all: '全部',
      favorite: '收藏'
    }
  },
  tab: {
    newSession: '新建会话',
    showAll: '显示所有标签',
    close: {
      one: '关闭',
      all: '关闭所有',
      others: '关闭其他标签页',
      left: '关闭左边',
      right: '关闭右边'
    },
    pin: '固定',
    unpin: '取消固定'
  },
  panel: {
    collapse: '收起侧栏',
    expand: '展开侧栏'
  },
  dock: {
    navLabel: '主导航',
    modesLabel: '工作台镜头',
    expandMenu: '展开左侧菜单',
    collapseMenu: '折叠左侧菜单',
    searchHint: '搜索 ⌘K',
    settingsHint: '设置 ⌘,'
  },
  activity: {
    title: 'AI 交互活跃（最近半年）',
    interactions: '{{count}} 次交互',
    streak: '连续 {{count}} 天 🔥'
  },
  hero: {
    greeting: '继续工作，{{name}}',
    taskPlaceholder: '输入任务，发送即开始一段对话…',
    selectCli: '选择 CLI',
    localCli: '本机 CLI',
    chatCli: '支持对话的 CLI',
    runtimeUpdated: '运行时已更新，请重启 Agent OS',
    readingRuntime: '正在读取 Runtime 能力…',
    noCli: '未发现可用 CLI',
    noChatCli: '没有支持对话的 CLI，去「装新 CLI」',
    pathPlaceholder: '输入或粘贴路径…',
    selectFolder: '选择文件夹',
    browse: '浏览…',
    workingDir: '工作目录',
    home: '~ 主目录',
    homeDefault: '~ 主目录（默认）',
    sendAria: '发送（⌘↵）',
    openTerminal: '打开终端',
    resumeLast: '继续上次',
    compareMode: '对比模式',
    installCli: '装新 CLI',
    newSessionName: '新会话',
    sessionNameTerminal: '{{base}} 终端',
    sessionNameChat: '{{base}} 会话',
    continuableTerminal: { one: '{{count}} 个可继续的终端', other: '{{count}} 个可继续的终端' },
    continuableChat: { one: '{{count}} 个可继续的会话', other: '{{count}} 个可继续的会话' },
    resumableBadge: '可继续 {{count}}',
    sectionHint: '点击左侧列表项或新建一个{{label}}任务'
  },
  session: {
    resume: '继续',
    favorite: '收藏',
    unfavorite: '取消收藏',
    delete: '删除会话',
    deleteTitle: '删除会话',
    deleteConfirm: '确定删除「{{name}}」？此操作不可撤销，关联的运行进程也会一并关闭。',
    multiSegment: '多 CLI 段落',
    segments: '{{count}} 段',
    createLinkedCli: '创建关联 CLI 会话',
    continueInCli: '在 CLI 中继续',
    copyPath: '复制路径',
    copyPathTitle: '复制工作目录路径',
    moreActions: '更多操作'
  },
  terminal: {
    resumeTitle: '继续上次工作',
    closedTitle: '终端已关闭',
    resumeHint: '上次终端会话仍可恢复，点击下方按钮继续。',
    openNewHint: '在「{{base}}」目录打开新终端，继续工作。',
    resume: '继续',
    openNew: '打开新终端'
  },
  notice: {
    close: '关闭提示',
    createFailed: '创建会话失败，请重试',
    pathCopied: '路径已复制：{{path}}',
    copyFailed: '复制失败，请手动复制'
  },
  chat: {
    emptyHint: '输入消息开始对话，工具调用与审批请求也会显示在这里。',
    system: '系统',
    thinking: '正在思考…',
    thinkingProcess: '思考过程',
    working: '正在{{verb}}…',
    unknownEvent: '未识别事件：{{type}}',
    loadError: '历史读取失败：{{error}}',
    composerPlaceholder: '给 {{tool}} 发送消息…',
    awaitingApproval: '请先处理审批请求',
    sendHint: 'Enter 发送 · Shift+Enter 换行',
    interrupt: '中断 Esc',
    sending: '发送中…',
    send: '发送',
    permission: {
      title: '需要你的确认 · {{name}}',
      deny: '拒绝',
      always: '总是允许',
      allowOnce: '允许一次',
      processing: '处理中…'
    },
    handoff: {
      aria: 'CLI 交接',
      text: '已从 {{from}} 交接给 {{to}}',
      doc: '携带交接文档'
    }
  },
  relay: {
    to: '接力给', current: '当前：{{value}}', loading: '正在读取 Agent…', empty: '没有可接力的 Agent',
    available: '可用', unavailable: '不可用', unavailableNotice: '{{name}} 暂不可接力：{{reason}}',
    checkCli: '请先检查 CLI 状态', model: '模型', start: '开始接力', failed: '接力失败', failedWithError: '接力失败：{{error}}',
    failedHint: '未能创建 {{name}} 会话。原会话没有变化。', close: '关闭',
    running: '正在接力给 {{name}}', prepare: '准备标准上下文包', create: '创建目标 Agent 会话',
    inject: '注入上下文', wait: '等待接手摘要', open: '打开新会话', cancel: '取消',
    from: '接力自 {{tool}}', relayedTo: '已接力给 {{tool}}', short: '接力', sourceShort: '来源',
    resumableRelayed: '可继续 · 已接力给 {{tool}}', runningFrom: '进行中 · 接力自 {{tool}}',
    source: '来源：{{title}}', newSession: '新会话：{{title}}', copyContext: '复制上下文路径'
  },
  tool: {
    status: {
      running: '执行中',
      failed: '失败',
      done: '已完成'
    },
    verb: {
      edit: '编辑 {{name}}',
      exec: '执行命令',
      search: '搜索',
      read: '读取 {{name}}',
      generic: '调用 {{name}}'
    }
  },
  tabs: {
    openContexts: '已打开的工作上下文',
    emptyHint: '打开的工作将在这里保留',
    newHint: '新建会话 ⌘N',
    newAria: '新建会话',
    closeAria: '关闭 {{title}}'
  },
  status: {
    session: {
      starting: '启动中',
      running: '工作中',
      waitingInput: '等待输入',
      resumable: '可继续',
      completed: '已完成',
      failed: '已失败',
      disconnected: '未运行'
    },
    health: {
      ready: '就绪',
      updatable: '可更新'
    }
  },
  time: {
    justNow: '刚刚',
    minutesAgo: '{{count}}分钟前',
    hoursAgo: '{{count}}小时前',
    daysAgo: '{{count}}天前'
  },
  compare: {
    newTitle: '新对比'
  },
  persona: {
    title: '用户画像'
  },
  memory: {
    newTitle: '新建记忆'
  }
}

export const en: typeof zh = {
  section: {
    chat: 'Sessions',
    board: 'Board',
    schedule: 'Schedule',
    compare: 'Compare',
    memory: 'Storage',
    web: 'Web',
    stats: 'Stats'
  },
  nav: {
    compare: 'Compare',
    memory: 'Memory',
    stats: 'Stats'
  },
  mode: {
    chat: 'Chat',
    cli: 'CLI',
    chatHint: 'Structured chat surface',
    cliHint: 'CLI terminal surface',
    newChat: 'New chat',
    newCli: 'New CLI'
  },
  rail: {
    sectionTerminal: 'Terminals',
    sectionSession: 'Sessions',
    aria: 'Workbench sessions',
    filterSessions: 'Filter sessions',
    clear: 'Clear',
    clearTagFilter: 'Clear tag filter',
    unnamedProject: 'Untitled project',
    emptyTerminal: 'No terminals',
    emptySession: 'No sessions',
    openTerminal: 'Open terminal',
    newSession: 'New session',
    selectAsWorkdir: 'Set as working directory for new sessions',
    filter: {
      all: 'All',
      favorite: 'Favorites'
    }
  },
  tab: {
    newSession: 'New session',
    showAll: 'Show all tabs',
    close: {
      one: 'Close',
      all: 'Close all',
      others: 'Close others',
      left: 'Close to left',
      right: 'Close to right'
    },
    pin: 'Pin',
    unpin: 'Unpin'
  },
  panel: {
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar'
  },
  dock: {
    navLabel: 'Main navigation',
    modesLabel: 'Workbench surfaces',
    expandMenu: 'Expand menu',
    collapseMenu: 'Collapse menu',
    searchHint: 'Search ⌘K',
    settingsHint: 'Settings ⌘,'
  },
  activity: {
    title: 'AI activity (last 6 months)',
    interactions: '{{count}} interactions',
    streak: '{{count}}-day streak 🔥'
  },
  hero: {
    greeting: 'Keep going, {{name}}',
    taskPlaceholder: 'Type a task and send to start a chat…',
    selectCli: 'Select CLI',
    localCli: 'Local CLIs',
    chatCli: 'Chat-capable CLIs',
    runtimeUpdated: 'Runtime updated — please restart Agent OS',
    readingRuntime: 'Reading runtime capabilities…',
    noCli: 'No CLI available',
    noChatCli: 'No chat-capable CLI — install one',
    pathPlaceholder: 'Type or paste a path…',
    selectFolder: 'Select folder',
    browse: 'Browse…',
    workingDir: 'Working directory',
    home: '~ Home',
    homeDefault: '~ Home (default)',
    sendAria: 'Send (⌘↵)',
    openTerminal: 'Open terminal',
    resumeLast: 'Resume last',
    compareMode: 'Compare mode',
    installCli: 'Install CLI',
    newSessionName: 'New session',
    sessionNameTerminal: '{{base}} Terminal',
    sessionNameChat: '{{base}} Chat',
    continuableTerminal: {
      one: '{{count}} resumable terminal',
      other: '{{count}} resumable terminals'
    },
    continuableChat: { one: '{{count}} resumable session', other: '{{count}} resumable sessions' },
    resumableBadge: 'Resumable {{count}}',
    sectionHint: 'Pick an item from the list on the left, or start a new {{label}}'
  },
  session: {
    resume: 'Resume',
    favorite: 'Favorite',
    unfavorite: 'Unfavorite',
    delete: 'Delete chat',
    deleteTitle: 'Delete chat',
    deleteConfirm:
      'Delete "{{name}}"? This cannot be undone, and linked running processes will be closed too.',
    multiSegment: 'Multi-CLI segments',
    segments: '{{count}} segments',
    createLinkedCli: 'Create linked CLI session',
    continueInCli: 'Continue in CLI',
    copyPath: 'Copy path',
    copyPathTitle: 'Copy working directory path',
    moreActions: 'More actions'
  },
  terminal: {
    resumeTitle: 'Resume last work',
    closedTitle: 'Terminal closed',
    resumeHint: 'The last terminal session can still be resumed. Click below to continue.',
    openNewHint: 'Open a new terminal in "{{base}}" to keep working.',
    resume: 'Resume',
    openNew: 'Open new terminal'
  },
  notice: {
    close: 'Dismiss notice',
    createFailed: 'Failed to create session. Please retry.',
    pathCopied: 'Path copied: {{path}}',
    copyFailed: 'Copy failed. Please copy manually.'
  },
  chat: {
    emptyHint: 'Type a message to start — tool calls and approval requests show here too.',
    system: 'System',
    thinking: 'Thinking…',
    thinkingProcess: 'Thinking',
    working: '{{verb}}…',
    unknownEvent: 'Unknown event: {{type}}',
    loadError: 'Failed to load history: {{error}}',
    composerPlaceholder: 'Send a message to {{tool}}…',
    awaitingApproval: 'Resolve the approval request first',
    sendHint: 'Enter to send · Shift+Enter for newline',
    interrupt: 'Interrupt Esc',
    sending: 'Sending…',
    send: 'Send',
    permission: {
      title: 'Needs your confirmation · {{name}}',
      deny: 'Deny',
      always: 'Always allow',
      allowOnce: 'Allow once',
      processing: 'Processing…'
    },
    handoff: {
      aria: 'CLI handoff',
      text: 'Handed off from {{from}} to {{to}}',
      doc: 'Carries handoff doc'
    }
  },
  relay: {
    to: 'Relay to', current: 'Current: {{value}}', loading: 'Loading agents…', empty: 'No agents available for relay',
    available: 'Available', unavailable: 'Unavailable', unavailableNotice: '{{name}} cannot receive a relay: {{reason}}',
    checkCli: 'Check the CLI status first', model: 'Model', start: 'Start relay', failed: 'Relay failed', failedWithError: 'Relay failed: {{error}}',
    failedHint: 'Could not create a {{name}} session. The original session is unchanged.', close: 'Close',
    running: 'Relaying to {{name}}', prepare: 'Prepare the standard context pack', create: 'Create the target agent session',
    inject: 'Inject context', wait: 'Wait for the takeover summary', open: 'Open the new session', cancel: 'Cancel',
    from: 'Relayed from {{tool}}', relayedTo: 'Relayed to {{tool}}', short: 'Relay', sourceShort: 'Source',
    resumableRelayed: 'Resumable · Relayed to {{tool}}', runningFrom: 'Running · Relayed from {{tool}}',
    source: 'Source: {{title}}', newSession: 'New session: {{title}}', copyContext: 'Copy context path'
  },
  tool: {
    status: {
      running: 'Running',
      failed: 'Failed',
      done: 'Done'
    },
    verb: {
      edit: 'Editing {{name}}',
      exec: 'Running command',
      search: 'Searching',
      read: 'Reading {{name}}',
      generic: 'Calling {{name}}'
    }
  },
  tabs: {
    openContexts: 'Open work contexts',
    emptyHint: 'Open work will be kept here',
    newHint: 'New session ⌘N',
    newAria: 'New session',
    closeAria: 'Close {{title}}'
  },
  status: {
    session: {
      starting: 'Starting',
      running: 'Working',
      waitingInput: 'Waiting for input',
      resumable: 'Resumable',
      completed: 'Completed',
      failed: 'Failed',
      disconnected: 'Not running'
    },
    health: {
      ready: 'Ready',
      updatable: 'Updatable'
    }
  },
  time: {
    justNow: 'Just now',
    minutesAgo: '{{count}} min ago',
    hoursAgo: '{{count}} h ago',
    daysAgo: '{{count}} d ago'
  },
  compare: {
    newTitle: 'New compare'
  },
  persona: {
    title: 'User persona'
  },
  memory: {
    newTitle: 'New memory'
  }
}
