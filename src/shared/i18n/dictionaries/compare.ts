// 对比工作台字典（SPEC-036）。Phase 2 由 compare agent 填充。
// 含 v3/sections/compare/*、pages/compare/*、domains/compare/service.ts。
// 注：会话名（对比 · X / [对比] X）、场景默认标题（未命名对比）、git commit 信息
// 属于存储数据值/文件内容，不迁移；品牌名（豆包/元宝）保留原样。

export const zh = {
  paneType: {
    chat: '会话',
    web: '网页'
  },
  webServiceHeader: '网页对话服务',
  pane: {
    sending: '发送中',
    loadingSite: '{{label}} 正在加载…',
    loadingHistory: '加载历史…',
    inputHint: '在下方批量输入，发送到 {{label}}',
    youLabel: '你'
  },
  toolbar: {
    badge: '对比',
    paneCount: '{{count}} 面板',
    addPane: '＋ 添加面板'
  },
  batch: {
    badge: '批量',
    placeholder: '同时发送到 {{count}} 个面板  ↵ 发送',
    sending: '发送中…',
    sendAll: '全部发送'
  },
  scenario: {
    unnamed: '未命名对比',
    sessionName: '对比 · {{name}}'
  },
  secPanel: {
    newCompare: '新对比',
    emptyHint: '输入一次任务，发送后会自动保存为方案。',
    emptyHint2: '下次点这里即可回到同一组对比。',
    deleteTitle: '删除对比记录（底层会话保留）',
    deleteAria: '删除 {{title}}'
  },
  page: {
    runTabTitle: '对比 {{id}}',
    surfaceAria: '对比镜头',
    cliSurface: 'CLI 对比',
    webSurface: 'Web 对比',
    promptPlaceholder: '输入任务 prompt，将同时发给各列 CLI…',
    starting: '启动中…',
    launch: '齐发',
    workdir: '工作目录',
    cliLabel: 'CLI：',
    selectHint: '请选 2–4 个',
    history: '历史：',
    cleanupRun: '清理此次运行',
    conflictBanner: '⚠ 合并冲突：{{conflict}}',
    conflictHint: '请在终端手动合并后清理，或选择其他列采纳。',
    waitingStart: '等待启动…',
    emptyTitle: '对比工作台',
    emptyHint: '选择 2–4 个 CLI，输入任务，点「齐发」。',
    emptySub: '每列在独立 git worktree 中运行，主工作区文件不受影响。',
    terminalInit: '终端初始化中…',
    adoptColumn: '采纳此列',
    adoptDialogTitle: '采纳此列',
    adoptConfirm: '确认采纳',
    adoptMessagePrefix: '将把 ',
    adoptMessageSuffix: '的改动以 squash commit 合并回主工作区，其余列的 worktree 与分支将被清理。',
    adoptWorkdir: '工作目录：'
  },
  service: {
    notGitRepo: '当前目录不是 git 仓库，无法使用对比工作台。',
    dirtyWorktree: '工作区有未提交的改动，请先提交或 stash 后再对比。',
    needClis: '对比需要 2–4 个 CLI。',
    runNotFound: '对比运行不存在',
    columnNotFound: '找不到指定列'
  }
}

export const en: typeof zh = {
  paneType: {
    chat: 'Session',
    web: 'Web'
  },
  webServiceHeader: 'Web chat services',
  pane: {
    sending: 'Sending…',
    loadingSite: '{{label}} loading…',
    loadingHistory: 'Loading history…',
    inputHint: 'Batch-enter below and send to {{label}}',
    youLabel: 'You'
  },
  toolbar: {
    badge: 'Compare',
    paneCount: '{{count}} panes',
    addPane: '＋ Add pane'
  },
  batch: {
    badge: 'Batch',
    placeholder: 'Send to {{count}} panes at once  ↵ to send',
    sending: 'Sending…',
    sendAll: 'Send all'
  },
  scenario: {
    unnamed: 'Untitled compare',
    sessionName: 'Compare · {{name}}'
  },
  secPanel: {
    newCompare: 'New compare',
    emptyHint: 'Enter a task once; it auto-saves as a scenario after sending.',
    emptyHint2: 'Click here next time to return to the same compare.',
    deleteTitle: 'Delete compare record (underlying sessions are kept)',
    deleteAria: 'Delete {{title}}'
  },
  page: {
    runTabTitle: 'Compare {{id}}',
    surfaceAria: 'Compare surface',
    cliSurface: 'CLI Compare',
    webSurface: 'Web Compare',
    promptPlaceholder: 'Enter a task prompt; it will be sent to every CLI column…',
    starting: 'Starting…',
    launch: 'Broadcast',
    workdir: 'Working directory',
    cliLabel: 'CLI:',
    selectHint: 'Select 2–4',
    history: 'History:',
    cleanupRun: 'Clean up this run',
    conflictBanner: '⚠ Merge conflict: {{conflict}}',
    conflictHint: 'Merge manually in the terminal then clean up, or adopt a different column.',
    waitingStart: 'Waiting to start…',
    emptyTitle: 'Compare Workbench',
    emptyHint: 'Select 2–4 CLIs, enter a task, and click "Broadcast".',
    emptySub: 'Each column runs in an isolated git worktree; the main workspace files are unaffected.',
    terminalInit: 'Terminal initializing…',
    adoptColumn: 'Adopt column',
    adoptDialogTitle: 'Adopt column',
    adoptConfirm: 'Confirm adoption',
    adoptMessagePrefix: 'Merge ',
    adoptMessageSuffix: "'s changes back into the main workspace as a squash commit; the other columns' worktrees and branches will be cleaned up.",
    adoptWorkdir: 'Working directory: '
  },
  service: {
    notGitRepo: 'The current directory is not a git repository; the compare workbench is unavailable.',
    dirtyWorktree: 'The working tree has uncommitted changes; commit or stash them before comparing.',
    needClis: 'Compare requires 2–4 CLIs.',
    runNotFound: 'Compare run does not exist',
    columnNotFound: 'Column not found'
  }
}
