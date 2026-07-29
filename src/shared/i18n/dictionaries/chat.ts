// 对话镜头字典（SPEC-036）。Phase 2 由 chat agent 填充。
// 含 v3/sections/chat/*、chat-model.ts、domains/chat/manager.ts 抛错。
// 注意：chat-model.ts 的状态/工具/过程标题被 tests/chat-model.test.ts 断言，
// zh 值必须与原文逐字一致（tr 默认 zh 返回相同中文→测试通过）。

export const zh = {
  // ─── 状态文案（chat-model.ts processStatusText） ─────────────────────────
  status: {
    awaitingConfirmation: '等待确认',
    failed: '执行失败',
    interrupted: '已中断',
    starting: '正在启动',
    idle: '空闲',
    thinking: '正在思考',
    replying: '正在输出回复',
    continuing: '继续执行',
    toolFailed: '工具调用失败',
    toolDone: '工具调用完成',
    working: '正在工作'
  },
  // ─── 工具动作文案（chat-model.ts toolActionText） ───────────────────────
  tool: {
    runningCommand: '正在运行命令',
    searchingCode: '正在搜索代码',
    matchingFiles: '正在匹配文件',
    readingFile: '正在读取文件',
    editingFile: '正在编辑文件',
    visitingPage: '正在访问网页',
    calling: '正在调用 {{name}}',
    /** tool ?? 默认工具名。 */
    default: '工具',
    error: '出错',
    running: '运行中…'
  },
  // ─── 过程/思考标题 ───────────────────────────────────────────────────────
  process: {
    historyTitle: '历史过程',
    runTitle: '执行过程',
    thinkingTitle: '思考过程',
    stepCount: '{{count}} 个步骤'
  },
  // ─── 权限状态标题（chat-model.ts permissionTitle） ──────────────────────
  permission: {
    allowedOnce: '已允许一次',
    allowedAlways: '已设为总是允许',
    denied: '已拒绝',
    needConfirm: '需要你的确认 · {{toolName}}',
    deny: '拒绝',
    alwaysAllow: '总是允许',
    allowOnce: '允许一次',
    processing: '处理中…'
  },
  // ─── transcript 步骤标题（chat-model.ts transcriptProcessStep） ─────────
  step: {
    localCommand: '本地命令 {{name}}',
    localCommandShort: '本地命令',
    localCommandOutput: '本地命令输出',
    toolResult: '工具结果',
    toolCall: '工具调用 {{tool}}',
    systemEvent: '系统事件'
  },
  // ─── 输出截断后缀（chat-model.ts compactOutput） ────────────────────────
  compact: {
    truncatedSuffix: '... 已截断 {{count}} 字符'
  },
  // ─── Hero 空态（ChatContent.tsx） ───────────────────────────────────────
  hero: {
    titlePrefix: '继续工作，',
    placeholderCli: '选择 CLI 与目录，点发送打开终端…',
    placeholderChat: '输入任务，发送即开始一段对话…'
  },
  // ─── 动作按钮 ────────────────────────────────────────────────────────────
  action: {
    openTerminal: '打开终端',
    send: '发送',
    steer: '调整方向',
    queue: '排队',
    newChat: '新对话',
    newCli: '新 CLI',
    interrupt: '中断',
    createSession: '新建会话'
  },
  taskAutomation: {
    created: '已创建定时任务「{{title}}」',
    failed: '定时任务创建失败：{{error}}'
  },
  // ─── 复制按钮 ────────────────────────────────────────────────────────────
  copy: {
    copied: '已复制'
  },
  // ─── 消息标注（收藏 + 标签） ─────────────────────────────────────────────
  anno: {
    favorite: '收藏消息',
    unfavorite: '取消收藏消息',
    editTags: '编辑消息标签'
  },
  // ─── 输入框 ──────────────────────────────────────────────────────────────
  input: {
    placeholder: '继续这个任务…',
    placeholderAwaiting: '等待你处理上方确认后继续…',
    awaitingHint: '等待工具调用确认，输入暂不可用'
  },
  queue: {
    title: '已排队 {{count}} 条',
    files: '附件: {{files}}',
    cancel: '取消排队'
  },
  scroll: {
    jumpLatest: '跳到最新'
  },
  // ─── 附件 ────────────────────────────────────────────────────────────────
  attach: {
    addFile: '添加附件',
    removeFile: '移除附件',
    fileList: '附件: {{files}}',
    unsupported: '当前 Agent 或模型不支持此类附件',
    tooLarge: '附件超过 25MB 限制',
    tooMany: '该 Agent 每次最多接收 {{count}} 个附件',
    dropHint: '拖放文件到此处即可上传',
    pasteFailed: '附件暂存失败'
  },
  find: {
    placeholder: '在当前会话内搜索…',
    prev: '上一个匹配',
    next: '下一个匹配'
  },
  // ─── 终端历史（会话关闭后展示） ─────────────────────────────────────────
  history: {
    closed: '已关闭',
    searchPlaceholder: '搜索历史记录…',
    reopen: '在此项目重新打开终端',
    loadEarlier: '加载更早记录',
    loadingRecords: '加载历史记录中…',
    searching: '搜索中…',
    noMatch: '未找到包含 "{{query}}" 的记录',
    empty: '暂无可读历史记录'
  },
  // ─── 终端外壳 ────────────────────────────────────────────────────────────
  terminal: {
    deleteSession: '删除会话',
    closeTerminal: '关闭终端'
  },
  // ─── 文件夹/会话列表（ChatSecPanel.tsx） ────────────────────────────────
  folder: {
    home: '~ 主目录'
  },
  mode: {
    chat: '会话',
    cli: 'CLI'
  },
  search: {
    placeholderChat: '搜索对话…',
    placeholderCli: '搜索终端…',
    aria: '搜索会话'
  },
  empty: {
    noMatchChat: '未找到匹配「{{query}}」的对话',
    noMatchCli: '未找到匹配「{{query}}」的终端',
    hintChat: '还没有对话，点上方新建一个。',
    hintCli: '还没有 CLI 终端，点上方新建一个。'
  },
  session: {
    unnamedChat: '未命名对话',
    unnamedCli: '未命名 CLI',
    surfaceChat: '对话',
    surfaceCli: 'CLI',
    sourceChannel: '渠道',
    sourceDesktop: '桌面',
    pin: '置顶对话',
    unpin: '取消置顶',
    archive: '归档对话'
  },
  // ─── CLI 启动弹窗（CliLaunchDialog.tsx） ────────────────────────────────
  cliDialog: {
    subtitle: '选择 CLI 工具与工作目录，立即启动一个原生终端会话。',
    cliTool: 'CLI 工具',
    workdir: '工作目录',
    start: '启动'
  },
  // ─── 远程节点状态（useSessionLaunch.ts） ────────────────────────────────
  node: {
    local: '本机',
    remoteNode: '远程节点',
    remotePrefix: '远程 · {{label}}',
    onlineWithCli: '在线 · {{count}} 个 CLI',
    onlineDiscovering: '在线 · 发现中',
    disabledHint: '已禁用 · 在节点设置启用',
    offlineFallback: '「{{label}}」已离线，已切回本机'
  },
  // ─── 会话创建（useSessionLaunch.ts launch） ─────────────────────────────
  launch: {
    nameChat: '{{base}} 会话',
    nameTerminal: '{{base}} 终端',
    newSession: '新会话',
    createFailed: '创建会话失败，请重试'
  },
  // ─── 主进程抛错（manager.ts） ────────────────────────────────────────────
  error: {
    sessionNotFound: '会话不存在',
    notChatSurface: '该会话不是对话镜头',
    noStructuredChat: '该 CLI 不支持结构化聊天',
    approvalExpired: '审批请求已失效',
    emptyPrompt: '请输入要发送的内容',
    steerFailed: '当前回合无法安全中断，调整方向未发送',
    turnInProgress: '当前会话已有进行中的回合',
    turnExited: '回合异常退出（code {{code}}）',
    startupTimeout:
      '{{toolId}} 长时间没有返回结构化输出，可能是 CLI 没有收到任务输入、登录/模型配置异常，或当前版本的输出格式已变化。'
  }
}

export const en: typeof zh = {
  status: {
    awaitingConfirmation: 'Waiting for confirmation',
    failed: 'Execution failed',
    interrupted: 'Interrupted',
    starting: 'Starting',
    idle: 'Idle',
    thinking: 'Thinking',
    replying: 'Typing reply',
    continuing: 'Continuing',
    toolFailed: 'Tool call failed',
    toolDone: 'Tool call complete',
    working: 'Working'
  },
  tool: {
    runningCommand: 'Running command',
    searchingCode: 'Searching code',
    matchingFiles: 'Matching files',
    readingFile: 'Reading file',
    editingFile: 'Editing file',
    visitingPage: 'Visiting page',
    calling: 'Calling {{name}}',
    default: 'Tool',
    error: 'Error',
    running: 'Running…'
  },
  process: {
    historyTitle: 'History',
    runTitle: 'Run',
    thinkingTitle: 'Thinking',
    stepCount: '{{count}} steps'
  },
  permission: {
    allowedOnce: 'Allowed once',
    allowedAlways: 'Always allowed',
    denied: 'Denied',
    needConfirm: 'Needs your confirmation · {{toolName}}',
    deny: 'Deny',
    alwaysAllow: 'Always allow',
    allowOnce: 'Allow once',
    processing: 'Processing…'
  },
  step: {
    localCommand: 'Local command {{name}}',
    localCommandShort: 'Local command',
    localCommandOutput: 'Local command output',
    toolResult: 'Tool result',
    toolCall: 'Tool call {{tool}}',
    systemEvent: 'System event'
  },
  compact: {
    truncatedSuffix: '... truncated {{count}} chars'
  },
  hero: {
    titlePrefix: 'Keep going, ',
    placeholderCli: 'Pick a CLI and directory, then send to open a terminal…',
    placeholderChat: 'Type a task, send to start a chat…'
  },
  action: {
    openTerminal: 'Open terminal',
    send: 'Send',
    steer: 'Steer',
    queue: 'Queue',
    newChat: 'New chat',
    newCli: 'New CLI',
    interrupt: 'Interrupt',
    createSession: 'New session'
  },
  taskAutomation: {
    created: 'Scheduled task “{{title}}” created',
    failed: 'Failed to create scheduled task: {{error}}'
  },
  copy: {
    copied: 'Copied'
  },
  anno: {
    favorite: 'Favorite message',
    unfavorite: 'Unfavorite message',
    editTags: 'Edit message tags'
  },
  input: {
    placeholder: 'Continue this task…',
    placeholderAwaiting: 'Resolve the confirmation above to continue…',
    awaitingHint: 'Waiting for tool-call confirmation; input is temporarily unavailable'
  },
  queue: {
    title: '{{count}} queued',
    files: 'Attachments: {{files}}',
    cancel: 'Cancel queued message'
  },
  scroll: {
    jumpLatest: 'Jump to latest'
  },
  attach: {
    addFile: 'Add attachment',
    removeFile: 'Remove attachment',
    fileList: 'Attachments: {{files}}',
    unsupported: 'The current agent or model does not support this attachment type',
    tooLarge: 'Attachment exceeds the 25MB limit',
    tooMany: 'This agent accepts at most {{count}} attachment(s) per turn',
    dropHint: 'Drop files here to attach',
    pasteFailed: 'Failed to stage attachment'
  },
  find: {
    placeholder: 'Find in this session…',
    prev: 'Previous match',
    next: 'Next match'
  },
  history: {
    closed: 'Closed',
    searchPlaceholder: 'Search history…',
    reopen: 'Reopen terminal in this project',
    loadEarlier: 'Load earlier records',
    loadingRecords: 'Loading history…',
    searching: 'Searching…',
    noMatch: 'No records containing "{{query}}"',
    empty: 'No readable history yet'
  },
  terminal: {
    deleteSession: 'Delete session',
    closeTerminal: 'Close terminal'
  },
  folder: {
    home: '~ Home'
  },
  mode: {
    chat: 'Chat',
    cli: 'CLI'
  },
  search: {
    placeholderChat: 'Search chats…',
    placeholderCli: 'Search terminals…',
    aria: 'Search sessions'
  },
  empty: {
    noMatchChat: 'No chats match “{{query}}”',
    noMatchCli: 'No terminals match “{{query}}”',
    hintChat: 'No chats yet — create one above.',
    hintCli: 'No CLI terminals yet — create one above.'
  },
  session: {
    unnamedChat: 'Untitled chat',
    unnamedCli: 'Untitled CLI',
    surfaceChat: 'Chat',
    surfaceCli: 'CLI',
    sourceChannel: 'Channel',
    sourceDesktop: 'Desktop',
    pin: 'Pin chat',
    unpin: 'Unpin',
    archive: 'Archive chat'
  },
  cliDialog: {
    subtitle: 'Pick a CLI tool and working directory to launch a native terminal session.',
    cliTool: 'CLI tool',
    workdir: 'Working directory',
    start: 'Start'
  },
  node: {
    local: 'Local',
    remoteNode: 'Remote node',
    remotePrefix: 'Remote · {{label}}',
    onlineWithCli: 'Online · {{count}} CLI',
    onlineDiscovering: 'Online · discovering',
    disabledHint: 'Disabled · enable in node settings',
    offlineFallback: '“{{label}}” went offline, switched back to local'
  },
  launch: {
    nameChat: '{{base}} Chat',
    nameTerminal: '{{base}} Terminal',
    newSession: 'New session',
    createFailed: 'Failed to create session, please retry'
  },
  error: {
    sessionNotFound: 'Session does not exist',
    notChatSurface: 'This session is not a chat surface',
    noStructuredChat: 'This CLI does not support structured chat',
    approvalExpired: 'Approval request has expired',
    emptyPrompt: 'Enter a message to send',
    steerFailed: 'The active turn could not be safely interrupted; the steer was not sent',
    turnInProgress: 'A turn is already running in this session',
    turnExited: 'Turn exited unexpectedly (code {{code}})',
    startupTimeout:
      '{{toolId}} has not returned structured output for a while. The CLI may not have received the task input, its login/model config may be invalid, or its output format has changed in this version.'
  }
}
