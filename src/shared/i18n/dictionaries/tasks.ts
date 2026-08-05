export const zh = {
  local: '本机',
  status: {
    queued: '排队中', running: '执行中', needsAttention: '需要处理', succeeded: '执行成功',
    failed: '执行失败', interrupted: '已中断', skipped: '已跳过'
  },
  timeline: {
    thinking: 'Agent 思考', toolUse: '调用工具', toolResult: '工具结果', permission: '权限请求',
    error: '执行错误', output: 'Agent 输出', input: '任务输入', handled: '处理状态：{{status}}'
  },
  detail: {
    aria: '任务详情：{{title}}', closeAria: '关闭任务详情', host: '目标主机', permissionSession: '权限 / 会话',
    newSession: '每次新会话', continueSession: '延续上次', updated: '最近更新', workspace: '工作目录',
    prompt: '任务说明', runs: '运行记录', loadingRuns: '正在读取运行记录…', neverRun: '尚未执行',
    scheduledTrigger: '定时触发', manualTrigger: '手动触发', process: '执行过程', deliveries: '交付物',
    loading: '读取中…', refresh: '刷新', sessionError: '会话过程读取失败：{{error}}',
    scheduledBy: '由定时计划触发', manualBy: '由用户手动触发', finishedAt: '{{time}} 结束',
    noProcess: '尚无执行过程', noProcessHint: '运行任务后，这里会显示 Agent 的思考、工具调用、权限处理和输出。',
    noRunProcess: '本次运行没有会话过程', noRunProcessSession: '会话尚未产生可展示内容，或目标节点暂时离线。',
    noRunProcessBeforeSession: '本次运行在创建会话前结束。', streaming: '生成中', final: '最终交付',
    noDelivery: '暂无交付物', runningDeliveryHint: 'Agent 仍在执行，最终回复产生后会显示在这里。',
    noDeliveryHint: '本次运行没有记录到 Agent 最终回复。', close: '关闭', openSession: '打开会话',
    confirming: '确认中…', confirm: '确认完成', readFailed: '读取会话过程失败'
  },
  panel: {
    board: '任务看板', schedules: '定时任务', newAria: '新建任务', boardTab: '看板', scheduleTab: '定时',
    newTask: '新建任务', newSchedule: '新建定时任务', running: '执行中', review: '待审阅', enabled: '已启用',
    loading: '正在读取 daemon 任务…', unavailable: 'Runtime 不可用：{{error}}',
    daemonHint: '任务由目标 Runtime daemon 持有；关闭桌面程序后，计划仍可继续。',
    recent: '最近更新', empty: '还没有任务'
  },
  board: {
    title: '任务看板', description: '先派单，再执行；Agent 完成后统一进入 Review，由你确认 Done。',
    todoHint: '等待派发', progressHint: 'Agent 正在工作', reviewHint: '人工检查结果', doneHint: '已确认完成',
    editAria: '编辑任务', lastRun: '最近一次执行：{{error}}', detail: '任务详情', run: '运行',
    openSession: '打开会话', confirm: '确认完成', delete: '删除', dropHere: '拖放任务到这里'
  },
  schedule: {
    onceLabel: '单次 · {{time}}', everyHours: '每隔 {{count}} 小时', everyMinutes: '每隔 {{count}} 分钟',
    title: '定时任务', description: '每个计划绑定一个目标 Runtime 和一个 Agent CLI，并保留独立运行记录。',
    next: '下一次', paused: '已暂停', detail: '任务详情', running: '执行中', runNow: '立即运行', pause: '暂停',
    enable: '启用', edit: '编辑', openSession: '打开会话', recentRuns: '最近运行', noRuns: '暂无运行记录',
    emptyTitle: '让重复工作按时发生', emptyHint: '新建一个单次、固定间隔或 Cron 计划，目标 daemon 会负责触发。'
  },
  composer: {
    selectAgentError: '请选择可用的 Agent CLI', editAria: '编辑任务', newAria: '新建任务', edit: '编辑任务',
    newSchedule: '新建定时任务', newTask: '新建任务', title: '标题', titlePlaceholder: '例如：每日回顾未解决问题',
    prompt: '任务说明 / 首轮 Prompt', promptPlaceholder: '说明目标、完成标准和边界…', select: '请选择',
    model: '模型（可选）', modelAuto: '由 CLI 决定', workspace: '工作目录', choose: '选择…', permission: '权限',
    sessionPolicy: '会话策略', newSession: '每次新会话', continueSession: '延续上次会话',
    autoWarning: '无人值守 + Auto 会允许 Agent 自主执行工具，请确认任务说明和工作目录安全。',
    schedule: '计划', none: '无', once: '单次', interval: '间隔', cron: '周期 / Cron', runAt: '执行时间',
    daily: '每天 09:00', weekdays: '工作日 09:00', friday: '每周五 18:00', cronField: '五段 Cron',
    every: '每隔', unit: '单位', minutes: '分钟', hours: '小时', timeZone: '时区', misfire: '错过计划',
    runOnce: '补跑一次', skip: '跳过', runAfter: '创建后立即运行', cancel: '取消', saving: '保存中…',
    save: '保存修改', create: '创建任务'
  }
}

export const en: typeof zh = {
  local: 'Local',
  status: {
    queued: 'Queued', running: 'Running', needsAttention: 'Needs attention', succeeded: 'Succeeded',
    failed: 'Failed', interrupted: 'Interrupted', skipped: 'Skipped'
  },
  timeline: {
    thinking: 'Agent thinking', toolUse: 'Tool call', toolResult: 'Tool result', permission: 'Permission request',
    error: 'Execution error', output: 'Agent output', input: 'Task input', handled: 'Handling status: {{status}}'
  },
  detail: {
    aria: 'Task details: {{title}}', closeAria: 'Close task details', host: 'Target host', permissionSession: 'Permission / session',
    newSession: 'New session each run', continueSession: 'Continue last session', updated: 'Last updated', workspace: 'Working directory',
    prompt: 'Task brief', runs: 'Run history', loadingRuns: 'Loading run history…', neverRun: 'Not run yet',
    scheduledTrigger: 'Scheduled', manualTrigger: 'Manual', process: 'Process', deliveries: 'Deliverables',
    loading: 'Loading…', refresh: 'Refresh', sessionError: 'Could not load the session process: {{error}}',
    scheduledBy: 'Triggered by schedule', manualBy: 'Triggered manually', finishedAt: 'Finished {{time}}',
    noProcess: 'No process yet', noProcessHint: 'Run the task to see agent thinking, tool calls, permission handling, and output here.',
    noRunProcess: 'No session process for this run', noRunProcessSession: 'The session has no displayable content yet, or the target node is offline.',
    noRunProcessBeforeSession: 'This run ended before a session was created.', streaming: 'Generating', final: 'Final delivery',
    noDelivery: 'No deliverables', runningDeliveryHint: 'The agent is still running. Its final response will appear here.',
    noDeliveryHint: 'No final agent response was recorded for this run.', close: 'Close', openSession: 'Open session',
    confirming: 'Confirming…', confirm: 'Confirm complete', readFailed: 'Could not load the session process'
  },
  panel: {
    board: 'Task board', schedules: 'Schedules', newAria: 'New task', boardTab: 'Board', scheduleTab: 'Schedule',
    newTask: 'New task', newSchedule: 'New scheduled task', running: 'Running', review: 'In review', enabled: 'Enabled',
    loading: 'Loading daemon tasks…', unavailable: 'Runtime unavailable: {{error}}',
    daemonHint: 'Tasks live in the target Runtime daemon, so schedules can continue after the desktop app closes.',
    recent: 'Recently updated', empty: 'No tasks yet'
  },
  board: {
    title: 'Task board', description: 'Assign, run, and review. Agent results enter Review before you confirm Done.',
    todoHint: 'Waiting to dispatch', progressHint: 'Agent at work', reviewHint: 'Review the result', doneHint: 'Confirmed complete',
    editAria: 'Edit task', lastRun: 'Latest run: {{error}}', detail: 'Task details', run: 'Run',
    openSession: 'Open session', confirm: 'Confirm complete', delete: 'Delete', dropHere: 'Drop tasks here'
  },
  schedule: {
    onceLabel: 'Once · {{time}}', everyHours: 'Every {{count}} hours', everyMinutes: 'Every {{count}} minutes',
    title: 'Schedules', description: 'Each schedule targets one Runtime and one Agent CLI, with an independent run history.',
    next: 'Next', paused: 'Paused', detail: 'Task details', running: 'Running', runNow: 'Run now', pause: 'Pause',
    enable: 'Enable', edit: 'Edit', openSession: 'Open session', recentRuns: 'Recent runs', noRuns: 'No run history',
    emptyTitle: 'Put recurring work on schedule', emptyHint: 'Create a one-time, interval, or Cron schedule. The target daemon handles execution.'
  },
  composer: {
    selectAgentError: 'Choose an available Agent CLI', editAria: 'Edit task', newAria: 'New task', edit: 'Edit task',
    newSchedule: 'New scheduled task', newTask: 'New task', title: 'Title', titlePlaceholder: 'For example: review unresolved issues every day',
    prompt: 'Task brief / first prompt', promptPlaceholder: 'Describe the goal, completion criteria, and boundaries…', select: 'Choose one',
    model: 'Model (optional)', modelAuto: 'Let the CLI decide', workspace: 'Working directory', choose: 'Choose…', permission: 'Permission',
    sessionPolicy: 'Session policy', newSession: 'New session each run', continueSession: 'Continue last session',
    autoWarning: 'Unattended + Auto lets the agent run tools autonomously. Verify that the brief and working directory are safe.',
    schedule: 'Schedule', none: 'None', once: 'Once', interval: 'Interval', cron: 'Recurring / Cron', runAt: 'Run at',
    daily: 'Daily at 09:00', weekdays: 'Weekdays at 09:00', friday: 'Fridays at 18:00', cronField: 'Five-field Cron',
    every: 'Every', unit: 'Unit', minutes: 'Minutes', hours: 'Hours', timeZone: 'Time zone', misfire: 'Missed run',
    runOnce: 'Run once', skip: 'Skip', runAfter: 'Run immediately after creation', cancel: 'Cancel', saving: 'Saving…',
    save: 'Save changes', create: 'Create task'
  }
}
