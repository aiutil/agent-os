// 跨域后端串字典（SPEC-036）：流入 UI 的后端文本——更新错误、数据面降级提示、
// 终端退出、dialog 标题、IPC 抛错等。主进程经 tr() 产出，默认 'zh' 故相关测试原样通过。
// 另含外观主题、错误边界、弹窗/确认框/复制按钮/表格无障碍文案、工具图标分类标签、
// 会话/记忆视图的用户提示等系统级 UI 串。

export const zh = {
  terminal: {
    sessionExited: '[会话已退出: {{exitCode}}]'
  },
  dataPlane: {
    drifted: '{{toolId}} 格式漂移',
    partial: '{{toolId}} 仅支持会话定位'
  },
  update: {
    noRelease: '未找到发布',
    checkFailed: '检查更新失败',
    downloadInProgress: '下载正在进行中',
    checkFirst: '请先检查更新',
    noDownloaded: '没有已下载的更新包',
    packageMissing: '更新包文件不存在',
    cannotOpen: '无法打开更新包',
    noAssetForPlatform: '未找到适用于 {{platform}} 的更新包',
    unverifiedAsset: '更新包缺少可验证的 SHA-256，已拒绝下载',
    unsafeAssetName: '更新包文件名不安全，已拒绝下载',
    updateTargetChanged: '下载期间更新目标已变化，请重新下载',
    integrityFailed: '更新包完整性校验失败，已删除下载文件',
    downloadFailed: '更新包下载失败：{{reason}}',
    downloadTimeout: '下载超时'
  },
  dialog: {
    selectDirectory: '选择工作目录',
    exportBackup: '导出 Agent OS 配置',
    importBackup: '导入 Agent OS 配置',
    selectFile: '选择附件',
    file: '文件',
    allFiles: '所有文件'
  },
  appearance: {
    system: '跟随系统',
    systemHint: '随操作系统外观自动切换',
    light: '浅色',
    lightHint: '始终浅色',
    dark: '深色',
    darkHint: '始终深色'
  },
  errorBoundary: {
    title: '出错了',
    fallback: '渲染时发生未知错误，可重试或重启应用。'
  },
  modal: {
    dialogLabel: '对话框'
  },
  confirm: {
    loadingSuffix: '{{text}}中…'
  },
  copy: {
    done: '已复制',
    failed: '复制失败'
  },
  table: {
    label: '表格'
  },
  toolIcon: {
    terminal: '终端',
    analysis: '统计',
    memory: '记忆',
    brain: '智能',
    code: '代码'
  },
  sessionNotice: {
    resumeFailed: '终端会话已失效，请打开新终端继续工作',
    resumeUnsupported: '此 CLI 不支持终端恢复，请打开新终端',
    startFailed: '终端启动失败，请稍后重试',
    reopened: '已新开终端会话',
    noTerminalLink: '会话尚未建立终端关联，请先在对话模式下使用',
    taskSessionUnavailable: '关联会话暂不可用，请确认任务所在节点在线。',
    taskSessionOpenFailed: '打开关联会话失败，请稍后重试。'
  },
  memoryView: {
    unavailable: '该记忆已不可用，可能已被移动或删除。',
    loadBeforeFailed: '加载更早记录失败。',
    fallbackTitle: '会话历史'
  }
}

export const en: typeof zh = {
  terminal: {
    sessionExited: '[Session exited: {{exitCode}}]'
  },
  dataPlane: {
    drifted: '{{toolId}} format drift',
    partial: '{{toolId}} supports session locating only'
  },
  update: {
    noRelease: 'No release found',
    checkFailed: 'Failed to check for updates',
    downloadInProgress: 'Download already in progress',
    checkFirst: 'Please check for updates first',
    noDownloaded: 'No downloaded update package',
    packageMissing: 'Update package file does not exist',
    cannotOpen: 'Unable to open update package',
    noAssetForPlatform: 'No update package found for {{platform}}',
    unverifiedAsset: 'The update package has no verifiable SHA-256 digest and was rejected',
    unsafeAssetName: 'The update asset name is unsafe and was rejected',
    updateTargetChanged: 'The update target changed during download. Download it again',
    integrityFailed: 'Update package integrity verification failed; the download was removed',
    downloadFailed: 'Update download failed: {{reason}}',
    downloadTimeout: 'Download timed out'
  },
  dialog: {
    selectDirectory: 'Select working directory',
    exportBackup: 'Export Agent OS configuration',
    importBackup: 'Import Agent OS configuration',
    selectFile: 'Select attachment',
    file: 'Files',
    allFiles: 'All files'
  },
  appearance: {
    system: 'Follow system',
    systemHint: 'Follow operating system appearance',
    light: 'Light',
    lightHint: 'Always light',
    dark: 'Dark',
    darkHint: 'Always dark'
  },
  errorBoundary: {
    title: 'Something went wrong',
    fallback: 'An unknown error occurred while rendering. Retry or restart the app.'
  },
  modal: {
    dialogLabel: 'Dialog'
  },
  confirm: {
    loadingSuffix: '{{text}}…'
  },
  copy: {
    done: 'Copied',
    failed: 'Copy failed'
  },
  table: {
    label: 'Table'
  },
  toolIcon: {
    terminal: 'Terminal',
    analysis: 'Analytics',
    memory: 'Memory',
    brain: 'Intelligence',
    code: 'Code'
  },
  sessionNotice: {
    resumeFailed: 'Terminal session is no longer valid. Please open a new terminal to continue.',
    resumeUnsupported: 'This CLI does not support terminal resume. Please open a new terminal.',
    startFailed: 'Failed to start terminal. Please try again later.',
    reopened: 'Opened a new terminal session',
    noTerminalLink: 'Session has no linked terminal yet. Use it in chat mode first.',
    taskSessionUnavailable:
      'The linked session is unavailable. Check that the task runtime is online.',
    taskSessionOpenFailed: 'Failed to open the linked session. Please try again.'
  },
  memoryView: {
    unavailable: 'This memory is no longer available. It may have been moved or deleted.',
    loadBeforeFailed: 'Failed to load earlier records.',
    fallbackTitle: 'Session history'
  }
}
