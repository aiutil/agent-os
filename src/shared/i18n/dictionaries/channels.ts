// 消息渠道字典（SPEC-036）。Phase 2 由 channels agent 填充。
// 含 onboarding/*、components/SearchModal.tsx、v3/shared/*(余)、
// domains/channels/{manager,renderer,acl}.ts。
//
// 注意：manager.ts / renderer.ts 的 IM 面向串（发给飞书等渠道用户的消息）也在此，
// 用 tr() 取。zh 值须与原文逐字一致（tests/channels.test.ts 断言 ackSegments 输出）。

export const zh = {
  onboarding: {
    title: '欢迎使用 Agent OS',
    subtitle: '个人 AI 超级工作台 — 正在扫描本机已安装的 AI CLI…',
    localCli: '本机 CLI',
    scanning: '扫描中…',
    rescan: '↻ 重新扫描',
    scanFailed: '扫描失败：{{error}}。可点击「重新扫描」重试，或直接进入工作台。',
    scanHint: '正在扫描 PATH 与常见安装位置…',
    noCliFound: '未在本机发现任何 AI CLI，可点击「重新扫描」或直接进入工作台。',
    missingLabel: '未发现：',
    enterFailed: '进入工作台失败：{{error}}',
    entering: '进入工作台中…',
    enter: '进入工作台 →',
    progress: '第 {{current}} / {{total}} 步',
    back: '上一步',
    next: '下一步',
    welcomeTitle: '先认识你的 AI 工作台',
    welcomeDesc: '这个向导会带你走完本机 CLI、Agent 对话、自动化、远程节点和消息渠道。',
    cliStepTitle: '连接本机 AI CLI',
    cliStepDesc: 'Agent OS 会扫描已安装工具；进入工作台后可在设置 → CLI 管理中安装、登录或升级。',
    agentStepTitle: '创建第一段 Agent 工作',
    agentStepDesc:
      '在对话首页选择运行位置、CLI、模型和项目目录，然后直接描述目标；也可以打开原生 CLI 终端。',
    agentChat: 'Agent 对话：结构化过程、审批、附件与记忆',
    agentCli: 'CLI 终端：保留工具原生交互体验',
    automationTitle: '把重复工作交给定时任务',
    automationDesc: '可在“定时”页创建，也可直接对 Agent 说“帮我创建明天 8 点检查服务的任务”。',
    automationSchedule: '一次、固定间隔、每天、工作日、每周和自定义 cron',
    automationReview: '执行过程、产物和失败原因都留在任务详情',
    connectTitle: '连接其他设备与消息渠道',
    connectDesc:
      '设置 → 远程托管可配对 Windows/macOS/Linux；消息渠道可接飞书、微信、企业微信、Telegram 和 WhatsApp。',
    connectRemote: '远程节点：在另一台机器运行 Agent/CLI',
    connectChannel: '消息渠道：从手机发起任务并接收结果',
    readyTitle: '准备完成',
    readyDesc:
      '数据默认保存在本机；消息正文、项目文件和凭据不会因为功能向导自动上传。你可以随时在设置中重新开始本向导。',
    readyTip: '建议进入后先创建一段 Agent 对话，再按需配置远程节点与消息渠道。'
  },
  search: {
    placeholder: '搜索会话标题、目录、CLI 或对话内容…',
    searching: '搜索中…',
    supplementing: '结果补全中…',
    tabChat: '对话',
    tabCli: 'CLI 终端',
    noMatch: '无匹配结果',
    noSessions: '暂无会话',
    groupChat: '对话',
    groupCli: 'CLI 终端',
    groupContent: '内容搜索',
    messageCount: {
      one: '{{count}} 条消息',
      other: '{{count}} 条消息'
    }
  },
  backend: {
    ariaLabel: '选择运行引擎',
    title: '选择运行引擎（在哪台机器上跑哪个 CLI）',
    selectEngine: '选择引擎',
    searchCli: '搜索 CLI…',
    local: '本机',
    noCliAvailable: '未发现可用 CLI',
    noCliInSection: '暂无可用 CLI',
    connectingHint: '连接节点后自动发现 CLI',
    disabledHint: '已禁用 · 在节点设置启用'
  },
  tool: {
    selectCli: '选择 CLI',
    selectTool: '选择工具',
    noCli: '未发现可用 CLI'
  },
  model: {
    loading: '加载模型…',
    remoteUnsupportedTitle: '远程节点暂不支持选模型（由该节点 CLI 自行决定）',
    remoteDecided: '由远程 CLI 决定',
    defaultWithLabel: '默认 · {{label}}',
    defaultModel: '默认模型',
    selectTitle: '选择模型（默认 = 由 CLI 自行解析）',
    defaultCliDecide: 'CLI 默认',
    customPlaceholder: '自定义模型 ID',
    useCustom: '使用',
    catalogUnavailable: '该 Agent 没有可读取的模型目录，可输入原生模型 ID',
    reasoningDefault: '思考：原生默认',
    reasoningTitle: '选择 Agent 原生思考级别'
  },
  workspace: {
    home: '~ 主目录',
    searchPlaceholder: '搜索项目',
    notFound: '未找到项目',
    addNew: '添加新项目',
    browseRemote: '浏览远程目录',
    usePath: '使用路径 {{path}}',
    noProject: '不使用项目'
  },
  message: {
    thinking: '🤔 思考中…',
    turnInProgress: '⏳ 当前会话仍在处理上一条消息（回复 /stop 可中断）',
    queued: '📋 已排队，当前第 {{position}} 条（回复 /stop 可中断当前回合并清空队列）',
    queueFull: '⚠️ 当前会话已有 5 条消息等待，请稍后再发或回复 /stop。',
    queueCancelled: '🗑️ 已取消 {{count}} 条等待消息。',
    turnIdUnavailable: '⚠️ 当前 Runtime 未返回可验证的回合 ID，已停止队列以避免消息串台。',
    takingOver: '⏳ {{label}} 接手中…',
    busyTurn: '⏳ 上一轮还在跑：{{message}}（回复 /stop 可中断）',
    noActiveTurn: '当前会话没有进行中的回合。',
    noAgentConfig: '⚠️ 暂无可用 agent。请先在 Agent OS 配置 Claude / OpenCode 等 CLI。',
    agentsListTitle: '📋 可用 agent：',
    currentAgent: '当前：{{name}}',
    notBound: '未绑定',
    switchHint: '发送 /use <name> 切换 · /new 重置对话 · /help 查看命令',
    welcomeNamed: '👏 {{name}}，你终于来了！',
    welcome: '👏 你终于来了！',
    welcomeReady: 'Agent OS 已就绪，以下是可用的 agent：',
    useNotFound: '❌ 未找到"{{arg}}"。可用：{{names}}\n发送 /agents 查看详情。',
    listSeparator: '、',
    noneAvailable: '暂无',
    alreadyCurrent: 'ℹ️ 当前已经是 {{name}}，无需切换。',
    switchedTo: '✅ 已切换到 {{name}}',
    noAgentForNew: '⚠️ 未发现可用 agent，无法新建对话。',
    newConversation: '✅ 已为 {{name}} 开启新对话。旧对话记录已保留，/use {{toolId}} 可切换回来。',
    completed: '✅ 已完成',
    interrupted: '🛑 已中断。',
    error: '⚠️ 出错：{{message}}',
    timeout: '⚠️ 本回合超过 10 分钟仍未结束，已停止等待。请在 Agent OS 查看会话或重试。',
    gatewayStopped: '🛑 Agent OS 消息网关已停止。',
    accessDenied:
      '🔒 此机器人仅向已授权用户开放。请把你的用户 ID `{{userId}}` 发给管理员，由管理员在 Agent OS「设置 → 消息渠道 → 访问控制」中授权。',
    pairingRequired:
      '🔐 需要管理员批准。配对码：`{{code}}`\n你的用户 ID：`{{userId}}`\n请让管理员在 Agent OS「设置 → 消息渠道 → 待批准请求」中核对并批准；1 小时后失效。本条请求尚未执行。',
    pairingQueueFull: '🔒 当前待批准请求已满，请联系管理员先处理已有请求后再试。本条请求尚未执行。',
    pairingApproved: '✅ 管理员已批准你的访问。之前的请求没有自动执行，请现在重新发送。',
    pairingRejected: '❌ 管理员未批准本次访问请求。如有疑问，请联系管理员。',
    inboundRecovery:
      '⚠️ Agent OS 在处理上一条请求时异常退出，无法安全判断该请求是否已经执行。为避免重复操作，本次不会自动重跑；请在桌面会话中确认后重新发送。',
    attachmentPrompt: '请查看并处理这 {{count}} 个附件。',
    attachmentsUnsupported: '⚠️ 当前消息中的附件无法安全下载，请改发文字或检查平台机器人权限。',
    attachmentDownloadFailed: '⚠️ 附件下载失败：{{message}}',
    cdDesktopOnly: 'ℹ️ 渠道暂不直接切换工作目录，请在 Agent OS 桌面端选择项目后发送 /new。',
    unknownCommand: '❓ 未知命令 /{{command}}。发送 /help 查看可用命令。',
    noBoundSession: '⚠️ 当前渠道尚未绑定会话，请先发送一条普通消息。',
    sessionsTitle: '💬 当前渠道会话：',
    noSessions: '暂无可切换会话',
    sessionSwitchHint: '发送 /session <编号或短 ID> 切换',
    switchWhileRunning: '⏳ 当前会话仍在执行，请先 /stop 或等待完成后再切换。',
    sessionSwitched: '✅ 已切换到会话「{{name}}」，历史与记忆保持不变。',
    referenceRequired: '请提供列表编号或短 ID',
    referenceNotFound: '未找到编号或 ID「{{ref}}」',
    referenceAmbiguous: '短 ID「{{ref}}」匹配多个项目，请提供更长的 ID',
    tasksTitle: '⏱️ 工作目录 {{workspace}} 的任务：',
    noTasks: '暂无任务',
    taskCommandHint:
      '命令：/task show <编号> · /task add <自然语言> · /task edit <编号> <自然语言> · /task pause|resume <编号> · /task delete <编号> confirm',
    taskManual: '手动',
    taskPaused: '已暂停',
    taskOnce: '单次',
    taskEveryHours: '每隔 {{count}} 小时',
    taskEveryMinutes: '每隔 {{count}} 分钟',
    taskAddInvalid: '⚠️ 无法识别计划。示例：/task add 每隔 30 分钟检查 ISSUE',
    taskEditInvalid: '⚠️ 无法识别新任务内容和计划。示例：/task edit 1 每天 9 点检查服务',
    taskCreated: '✅ 已创建「{{title}}」· {{schedule}}',
    taskUpdated: '✅ 已更新「{{title}}」',
    taskScheduleLabel: '计划',
    taskAgentLabel: 'Agent',
    taskStatusLabel: '状态',
    taskNoSchedule: '⚠️ 该任务没有计划，无法暂停或恢复。',
    taskResumed: '▶️ 已恢复「{{title}}」',
    taskPausedDone: '⏸️ 已暂停「{{title}}」',
    taskDeleteConfirm: '⚠️ 确认删除「{{title}}」请发送 /task delete {{ref}} confirm',
    taskDeleted: '🗑️ 已删除「{{title}}」',
    steerUsage: '用法：/steer <新的方向或补充要求>',
    steering: '↪️ 已收到调整指令，正在按新方向继续。',
    helpBody: [
      '🤖 Agent OS 消息命令',
      '',
      '直接发送文字或附件：开始任务',
      '/agents：查看可用 agent',
      '/use <agent>：切换 agent',
      '/new：开启新对话',
      '/sessions、/session <编号>：查看或切换会话',
      '/tasks、/task ...：查看和管理定时任务',
      '/steer <指令>：运行中立即调整方向',
      '/status：查看连接、回合和队列状态',
      '/open：在 Agent OS 桌面端打开当前会话',
      '/stop：中断当前回合并清空队列',
      '/help：显示本帮助',
      '',
      '群聊中请 @机器人后再发送。'
    ].join('\n')
  },
  error: {
    accountNotFound: '账号不存在',
    scanUnsupported: '当前渠道不支持扫码接入',
    cancelled: '已取消'
  }
}

export const en: typeof zh = {
  onboarding: {
    title: 'Welcome to Agent OS',
    subtitle: 'Personal AI super workbench — scanning for installed AI CLIs…',
    localCli: 'Local CLIs',
    scanning: 'Scanning…',
    rescan: '↻ Rescan',
    scanFailed: 'Scan failed: {{error}}. Click "Rescan" to retry, or enter the workbench directly.',
    scanHint: 'Scanning PATH and common install locations…',
    noCliFound: 'No AI CLI found on this machine. Click "Rescan" or enter the workbench directly.',
    missingLabel: 'Not found:',
    enterFailed: 'Failed to enter workbench: {{error}}',
    entering: 'Entering workbench…',
    enter: 'Enter workbench →',
    progress: 'Step {{current}} of {{total}}',
    back: 'Back',
    next: 'Next',
    welcomeTitle: 'Meet your AI workbench',
    welcomeDesc:
      'This guide covers local CLIs, agent chat, automation, remote nodes, and message channels.',
    cliStepTitle: 'Connect local AI CLIs',
    cliStepDesc:
      'Agent OS scans installed tools. Later, use Settings → CLI Management to install, sign in, or upgrade.',
    agentStepTitle: 'Start your first Agent task',
    agentStepDesc:
      'Choose a runtime, CLI, model, and project folder, then describe the outcome. Native CLI terminals are also available.',
    agentChat: 'Agent chat: structured progress, approvals, attachments, and memory',
    agentCli: 'CLI terminal: preserve the tool’s native interaction',
    automationTitle: 'Schedule recurring work',
    automationDesc:
      'Create schedules in the Schedule page, or tell an Agent “create a task for tomorrow at 8 AM to check the service.”',
    automationSchedule: 'Once, fixed intervals, daily, weekdays, weekly, and custom cron',
    automationReview: 'Progress, deliverables, and failures stay in task details',
    connectTitle: 'Connect devices and message channels',
    connectDesc:
      'Pair Windows/macOS/Linux in Settings → Remote Hosting, and connect Feishu, WeChat, WeCom, Telegram, or WhatsApp.',
    connectRemote: 'Remote nodes: run Agents and CLIs on another computer',
    connectChannel: 'Message channels: start work from your phone and receive results',
    readyTitle: 'Ready to go',
    readyDesc:
      'Data stays local by default. The guide does not upload message text, project files, or credentials. You can restart it anytime in Settings.',
    readyTip:
      'Start with an Agent chat, then connect remote nodes and message channels when needed.'
  },
  search: {
    placeholder: 'Search session titles, paths, CLIs, or chat content…',
    searching: 'Searching…',
    supplementing: 'Supplementing results…',
    tabChat: 'Chat',
    tabCli: 'CLI Terminal',
    noMatch: 'No matching results',
    noSessions: 'No sessions yet',
    groupChat: 'Chat',
    groupCli: 'CLI Terminal',
    groupContent: 'Content search',
    messageCount: {
      one: '{{count}} message',
      other: '{{count}} messages'
    }
  },
  backend: {
    ariaLabel: 'Select runtime engine',
    title: 'Select runtime engine (which CLI runs on which machine)',
    selectEngine: 'Select engine',
    searchCli: 'Search CLI…',
    local: 'Local',
    noCliAvailable: 'No CLI available',
    noCliInSection: 'No CLI available',
    connectingHint: 'CLIs are discovered automatically once connected',
    disabledHint: 'Disabled · enable in node settings'
  },
  tool: {
    selectCli: 'Select CLI',
    selectTool: 'Select tool',
    noCli: 'No CLI available'
  },
  model: {
    loading: 'Loading models…',
    remoteUnsupportedTitle:
      'Remote node does not support model selection (decided by the remote CLI)',
    remoteDecided: 'Decided by remote CLI',
    defaultWithLabel: 'Default · {{label}}',
    defaultModel: 'Default model',
    selectTitle: 'Select model (default = resolved by the CLI)',
    defaultCliDecide: 'CLI default',
    customPlaceholder: 'Custom model ID',
    useCustom: 'Use',
    catalogUnavailable: 'This Agent exposes no readable catalog; enter a native model ID',
    reasoningDefault: 'Reasoning: native default',
    reasoningTitle: 'Select the Agent-native reasoning effort'
  },
  workspace: {
    home: '~ Home',
    searchPlaceholder: 'Search projects',
    notFound: 'No projects found',
    addNew: 'Add new project',
    browseRemote: 'Browse remote folders',
    usePath: 'Use path {{path}}',
    noProject: 'No project'
  },
  message: {
    thinking: '🤔 Thinking…',
    turnInProgress:
      '⏳ This conversation is still processing the previous message (reply /stop to interrupt)',
    queued:
      '📋 Queued at position {{position}} (reply /stop to interrupt the current turn and clear the queue)',
    queueFull:
      '⚠️ This conversation already has 5 waiting messages. Try again later or reply /stop.',
    queueCancelled: '🗑️ Cancelled {{count}} waiting messages.',
    turnIdUnavailable:
      '⚠️ The Runtime did not return a verifiable turn ID. The queue was stopped to prevent cross-turn message corruption.',
    takingOver: '⏳ {{label}} is taking over…',
    busyTurn: '⏳ Previous turn still running: {{message}} (reply /stop to interrupt)',
    noActiveTurn: 'No active turn in this session.',
    noAgentConfig:
      '⚠️ No agent available. Configure CLIs such as Claude / OpenCode in Agent OS first.',
    agentsListTitle: '📋 Available agents:',
    currentAgent: 'Current: {{name}}',
    notBound: 'Not bound',
    switchHint: 'Send /use <name> to switch · /new to reset · /help for commands',
    welcomeNamed: '👏 {{name}}, you are finally here!',
    welcome: '👏 You are finally here!',
    welcomeReady: 'Agent OS is ready. Available agents:',
    useNotFound: '❌ "{{arg}}" not found. Available: {{names}}\nSend /agents for details.',
    listSeparator: ', ',
    noneAvailable: 'none',
    alreadyCurrent: 'ℹ️ Already on {{name}}, no need to switch.',
    switchedTo: '✅ Switched to {{name}}',
    noAgentForNew: '⚠️ No agent available, cannot start a new conversation.',
    newConversation:
      '✅ Started a new conversation for {{name}}. Previous records are kept; /use {{toolId}} to switch back.',
    completed: '✅ Done',
    interrupted: '🛑 Interrupted.',
    error: '⚠️ Error: {{message}}',
    timeout:
      '⚠️ This turn did not finish within 10 minutes. Check the session in Agent OS or retry.',
    gatewayStopped: '🛑 The Agent OS message gateway has stopped.',
    accessDenied:
      '🔒 This bot is available only to authorized users. Send your user ID `{{userId}}` to the administrator, who can authorize it in Agent OS under Settings → Message channels → Access control.',
    pairingRequired:
      '🔐 Administrator approval is required. Pairing code: `{{code}}`\nYour user ID: `{{userId}}`\nAsk the administrator to verify and approve it in Agent OS under Settings → Message channels → Pending requests. It expires in 1 hour. This request was not executed.',
    pairingQueueFull:
      '🔒 The pending approval queue is full. Ask the administrator to process an existing request, then try again. This request was not executed.',
    pairingApproved:
      '✅ The administrator approved your access. Your earlier request was not executed; send it again now.',
    pairingRejected:
      '❌ The administrator did not approve this access request. Contact the administrator if you need help.',
    inboundRecovery:
      '⚠️ Agent OS exited while handling the previous request, so it cannot safely determine whether the action already ran. It will not replay it automatically; check the desktop session, then send it again if needed.',
    attachmentPrompt: 'Please inspect and process these {{count}} attachments.',
    attachmentsUnsupported:
      '⚠️ The attachments in this message cannot be downloaded safely. Send text instead or check the bot permissions.',
    attachmentDownloadFailed: '⚠️ Attachment download failed: {{message}}',
    cdDesktopOnly: 'ℹ️ Change the workspace in the Agent OS desktop app, then send /new.',
    unknownCommand: '❓ Unknown command /{{command}}. Send /help to see available commands.',
    noBoundSession: '⚠️ This channel is not bound to a session yet. Send a normal message first.',
    sessionsTitle: '💬 Sessions for this channel:',
    noSessions: 'No switchable sessions',
    sessionSwitchHint: 'Send /session <number or short ID> to switch',
    switchWhileRunning:
      '⏳ The current session is still running. Use /stop or wait before switching.',
    sessionSwitched: '✅ Switched to “{{name}}”; history and memory are preserved.',
    referenceRequired: 'Provide a list number or short ID',
    referenceNotFound: 'No item matches “{{ref}}”',
    referenceAmbiguous: 'Short ID “{{ref}}” is ambiguous; provide a longer ID',
    tasksTitle: '⏱️ Tasks for workspace {{workspace}}:',
    noTasks: 'No tasks',
    taskCommandHint:
      'Commands: /task show <number> · /task add <natural language> · /task edit <number> <natural language> · /task pause|resume <number> · /task delete <number> confirm',
    taskManual: 'manual',
    taskPaused: 'paused',
    taskOnce: 'once',
    taskEveryHours: 'every {{count}} hours',
    taskEveryMinutes: 'every {{count}} minutes',
    taskAddInvalid:
      '⚠️ Could not recognize the schedule. Example: /task add every 30 minutes check issues',
    taskEditInvalid: '⚠️ Could not recognize the new task and schedule.',
    taskCreated: '✅ Created “{{title}}” · {{schedule}}',
    taskUpdated: '✅ Updated “{{title}}”',
    taskScheduleLabel: 'Schedule',
    taskAgentLabel: 'Agent',
    taskStatusLabel: 'Status',
    taskNoSchedule: '⚠️ This task has no schedule to pause or resume.',
    taskResumed: '▶️ Resumed “{{title}}”',
    taskPausedDone: '⏸️ Paused “{{title}}”',
    taskDeleteConfirm: '⚠️ To delete “{{title}}”, send /task delete {{ref}} confirm',
    taskDeleted: '🗑️ Deleted “{{title}}”',
    steerUsage: 'Usage: /steer <new direction or correction>',
    steering: '↪️ Direction updated; continuing with the new instruction.',
    helpBody: [
      '🤖 Agent OS message commands',
      '',
      'Send text or attachments: start a task',
      '/agents: list available agents',
      '/use <agent>: switch agent',
      '/new: start a new conversation',
      '/sessions, /session <number>: list or switch sessions',
      '/tasks, /task ...: view and manage scheduled tasks',
      '/steer <instruction>: steer the active turn immediately',
      '/status: show connection, turn, and queue status',
      '/open: open this session in the Agent OS desktop app',
      '/stop: interrupt the current turn and clear the queue',
      '/help: show this help',
      '',
      'In group chats, mention the bot before sending.'
    ].join('\n')
  },
  error: {
    accountNotFound: 'Account does not exist',
    scanUnsupported: 'This channel does not support scan-to-connect',
    cancelled: 'Cancelled'
  }
}
