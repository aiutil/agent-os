// 记忆字典（SPEC-036）。含 pages/memory/*、v3/sections/storage/*、domains/memory/{vault,curation}.ts。
// vault/curation 抛错的 zh 值须与原文逐字一致：tests/memory-vault.test.ts 用 toThrow 子串断言
// （"疑似密钥"、"未启用"、"外部上下文"等），tr 默认 zh 返回相同中文→测试通过。
// system-prompt / markdown 生成（DEFAULT_CURATION_INSTRUCTIONS、context()、renderMemory、exportSnapshot）
// 属 LLM/文件内容，不在本字典。

export const zh = {
  tab: {
    sessions: '会话',
    experience: '经验库',
    candidates: '候选箱',
    policy: '策略与接入'
  },
  index: {
    building: '正在建立索引… {{indexed}}/{{total}} 文件'
  },
  dataPlane: {
    degradedTitle: '部分数据源已降级',
    failedFiles: '{{count}} 个会话文件无法解析',
    failedFilesHint: '其余历史会话仍可正常搜索，重启应用会自动重试失败文件。'
  },
  search: {
    aria: '搜索会话',
    placeholder: '搜索会话内容、标题、目录…',
    searching: '搜索中…',
    resultCount: { one: '{{count}} 个会话', other: '{{count}} 个会话' }
  },
  filter: {
    workspaceAria: '项目过滤',
    allWorkspaces: '全部项目',
    clearDateAria: '清除日期过滤',
    dateAria: '时间过滤',
    dateAll: '全部时间',
    dateToday: '今天',
    date7d: '近 7 天',
    date30d: '近 30 天'
  },
  empty: {
    buildingTitle: '索引正在建立',
    buildingHint: '历史会话会在解析完成后陆续出现。',
    noHistoryTitle: '尚无历史会话',
    noHistoryHint: '使用 Claude Code、Codex 等工具开始工作后，历史会话会自动收录。',
    noMatchTitle: '没有匹配的会话',
    noMatchHint: '尝试更换关键词或清除过滤条件。'
  },
  hit: {
    unknownCwd: '未知目录',
    messageCount: { one: '{{count}} 条消息', other: '{{count}} 条消息' }
  },
  detail: {
    aria: '会话详情',
    defaultTitle: '记忆详情',
    defaultTool: '历史会话',
    closeAria: '关闭详情',
    loadingTranscript: '正在读取会话记录…',
    errorTitle: '记忆详情失效',
    roleUser: '你',
    creating: '正在创建…',
    openNew: '在此目录新开会话',
    curatingExp: '沉淀中…',
    curateExp: '沉淀为经验',
    curating: '提炼中…',
    curateCandidate: '提炼候选',
    notFound: '该记忆已不存在或已被删除。',
    storedAt: '存储于 {{time}}',
    saveEdit: '保存修改',
    confirmDelete: '确认删除？',
    unpinAria: '取消置顶（不再优先注入）',
    pinAria: '置顶（每次都优先注入此记忆）',
    pinned: '📌 已置顶',
    pin: '📌 置顶',
    pinnedBadge: '已置顶',
    evidenceManual: '人工确认',
    scopeRefHint: '如果作用域不是「user」，会自动显示作用域引用字段。',
    evidenceHint: '证据不随编辑改变：{{evidence}}',
    tagsLabel: '标签：{{tags}}',
    evidenceLabel: '证据：{{evidence}}',
    createdUpdatedAt: '创建 {{created}} · 更新 {{updated}}',
    createTitle: '新建记忆',
    createNote:
      '手动新建的记忆会立即生效，并标记为「手动」来源。建议只录入稳定、可复用、不会很快过期的偏好、约定或事实。',
    field: {
      titleAria: '记忆标题',
      titlePlaceholder: '标题',
      contentAria: '记忆内容',
      contentPlaceholder: '记忆内容',
      kindAria: '记忆类型',
      scopeAria: '记忆作用域',
      scopeRefAria: '作用域引用',
      scopeRefAgent: 'Agent ID',
      scopeRefPath: '项目或路径',
      tagsAria: '记忆标签',
      tagsPlaceholder: '标签，以逗号分隔'
    },
    error: {
      titleContentEmpty: '标题与内容不能为空',
      createFailed: '新建记忆失败',
      notExists: '该记忆已不存在或状态已变化',
      saveFailed: '保存记忆失败'
    }
  },
  experience: {
    title: '长期记忆',
    subtitle: '已确认的知识会在允许的任务中按作用域召回 · 共 {{count}} 条',
    emptyTitle: '还没有已确认的长期记忆',
    emptyHint: '从会话详情沉淀，或在候选箱中确认 agent 提议。',
    fromTool: '来自 {{tool}}',
    confirmed: '已确认',
    deleteAria: '删除经验：{{title}}',
    deleteTitle: '删除经验',
    deleteMessage: '删除后无法恢复，确定删除该经验条目？'
  },
  candidates: {
    title: '候选记忆',
    subtitle: 'Agent 与后台提炼只能写入此处；确认前绝不注入任何新任务。',
    emptyTitle: '候选箱为空',
    emptyHint: '支持 MCP 的 agent 可以通过 memory_propose 提交候选。',
    reject: '拒绝'
  },
  policy: {
    title: '策略与接入',
    subtitle: '记忆只保存在本机。规则文件和显式用户指令始终优先于记忆。',
    curator: '记忆提炼 Agent',
    noCurator: '尚未发现支持隔离提炼的 CLI（如 pi）。',
    tokenBudget: 'Context Pack 预算（token）',
    gatewayTitle: 'Agent 接入能力',
    setting: {
      enabledTitle: '启用 Memory Vault',
      enabledDesc: '关闭时所有 agent 都不会接收长期记忆。',
      useMemoriesTitle: '允许新任务使用记忆',
      useMemoriesDesc: '可保留记忆但暂时禁止上下文注入。',
      generateMemoriesTitle: '允许后台沉淀记忆',
      generateMemoriesDesc: '系统使用可用的提炼 Agent；所有类型和来源共用本地自然日额度，每天最多新增 1 条。',
      allowExternalTitle: '允许外部上下文参与提炼',
      allowExternalDesc: '默认关闭，避免 Web/MCP 内容污染长期记忆。'
    }
  },
  notice: {
    indexStatusFailed: '索引状态读取失败：{{message}}',
    searchFailed: '搜索失败：{{message}}',
    experienceFailed: '经验库读取失败：{{message}}',
    vaultFailed: '长期记忆读取失败：{{message}}',
    noCwd: '该历史会话没有可用的工作目录',
    createSessionFailed: '新开会话失败：{{message}}',
    curatedToExperience: '已沉淀到经验库',
    curateFailed: '沉淀失败：{{message}}',
    curateNoCwd: '该历史会话没有工作目录，无法安全发起记忆提炼。',
    curateNoText: '该会话没有可用于提炼的用户或助手文本。',
    curated: '已生成 {{count}} 条候选记忆，等待确认。',
    curateEmpty: '未发现可沉淀的稳定记忆。',
    curateRunFailed: '提炼失败：{{message}}',
    confirmed: '候选记忆已确认，并会在后续允许的任务中被召回。',
    rejected: '候选记忆已归档，不会进入 agent 上下文。',
    closeAria: '关闭提示'
  },
  time: {
    justNow: '刚刚',
    minutesAgo: '{{count}}分钟前',
    minutesAgoShort: '{{count}} 分前',
    hoursAgo: '{{count}} 小时前',
    hoursAbbr: '{{count}}h前',
    daysAgo: '{{count}}天前',
    daysAgoShort: '{{count}} 天前',
    fullDateFallback: '{{date}} 的对话'
  },
  fav: {
    favoriteOnly: '★ 仅收藏',
    empty: '暂无收藏或标签。在会话或消息上点 ★ 收藏、# 加标签即可。',
    untitled: '(无标题)',
    messageKind: '消息',
    starAria: '收藏',
    unstarAria: '取消收藏',
    editTagsAria: '编辑标签',
    editMessageTags: '编辑消息标签',
    editSessionTags: '编辑会话标签'
  },
  persona: {
    title: '用户画像',
    undo: '撤销',
    savedAt: '已保存于 {{time}}',
    globalHint: '手动维护 · 全局生效',
    heroTitle: '协作偏好会先于长期记忆生效',
    heroDesc:
      '描述「你是谁、怎么干活、什么设计哲学」的稳定画像。建议写沟通语言与风格、代码取舍倾向、何时主动确认、不可让步的约定。',
    editorTitle: '用户画像',
    editorMeta: '全局单份 · 手动维护',
    charCount: { one: '{{count}} 字', other: '{{count}} 字' },
    placeholder:
      '例如：\n- 用中文回复，代码与专有名词保持原文。\n- 倾向最小改动，不顺手重构无关代码。\n- 涉及破坏性操作（删库/强推）先问我。',
    error: {
      loadFailed: '加载用户画像失败',
      saveFailed: '保存用户画像失败'
    }
  },
  record: {
    starMsgAria: '收藏消息',
    unstarMsgAria: '取消收藏消息',
    editMsgTagsAria: '编辑消息标签',
    editMsgTagsTitle: '编辑消息标签',
    stepCount: { one: '{{count}} 个步骤', other: '{{count}} 个步骤' },
    thinking: '思考过程',
    loadMore: '向上滚动加载更早消息',
    empty: '暂无可读历史记录',
    relayTo: '接力给'
  },
  storage: {
    historyConv: '历史对话',
    untitled: '(无标题)',
    searchPlaceholder: '搜索会话记录…',
    searchMemoryPlaceholder: '搜索长期记忆…',
    favoriteOnly: '★ 仅收藏',
    noTags: '暂无标签 · 在记录或消息上点 # 添加',
    collapse: '收起',
    expand: '展开',
    removeCondAria: '移除该条件',
    clearAll: '清空',
    searching: '搜索中…',
    noMatch: '没有符合条件的记录',
    empty: '暂无记录',
    messageKind: '消息',
    starAria: '收藏',
    unstarAria: '取消收藏',
    editTagsAria: '编辑标签',
    sourceCli: 'CLI',
    sourceAgent: '对话',
    indexing: '索引中 {{indexed}}/{{total}}',
    memoryCount: { one: '{{count}} 条记忆', other: '{{count}} 条记忆' },
    addMemoryAria: '手动新建一条记忆',
    addMemory: '+ 新建',
    candidatesPending: '条候选待确认',
    reject: '拒绝',
    noMemoryMatch: '没有匹配的记忆',
    noMemoryMatchHint: '换个关键词，或清空搜索查看全部。',
    noMemory: '还没有长期记忆',
    noMemoryHint: '开启提炼后，会话沉淀的记忆会自动出现在这里。',
    personaSummaryEmpty: '点击编辑你的协作偏好',
    modeMemory: '记忆',
    modePersona: '人格',
    navSession: '会话',
    navMemory: '记忆',
    navKnowledge: '知识',
    knowledgeTitle: '知识库即将上线',
    knowledgeDesc: '智能体将把会话沉淀为 Obsidian 兼容的 md 笔记，敬请期待。',
    editMessageTags: '编辑消息标签',
    editSessionTags: '编辑会话标签',
    time: {
      all: '全部',
      today: '今天',
      d7: '7天',
      d30: '30天'
    },
    source: {
      all: '全部',
      agent: '对话',
      cli: 'CLI'
    },
    filterLabel: {
      time: '时间',
      source: '来源',
      favorite: '收藏',
      tags: '标签'
    },
    memSource: {
      feishu: '飞书',
      session: '会话',
      cli: 'CLI',
      manual: '手动'
    }
  },
  tagEditor: {
    empty: '暂无标签，输入后回车添加。',
    removeTagAria: '移除标签 {{tag}}',
    placeholder: '新标签，回车添加'
  },
  atlas: {
    common: {
      findNode: '查找节点',
      fitCanvas: '适应画布',
      hideSources: '隐藏当前来源',
      showSources: '展开当前来源',
      navigator: '图谱节点导航',
      nodePlaceholder: '输入节点名称',
      truncated: '默认展示最近活跃的 {{count}} 条内容，搜索可定位其余条目。',
      memoryGraphAria: '圆形记忆图谱。单击节点在右侧查看详情，双击扩展阅读；拖动空白区域平移，滚轮缩放。',
      knowledgeGraphAria: '圆形知识图谱。单击节点在右侧查看详情，双击扩展阅读；拖动空白区域平移，滚轮缩放。',
      emptyTitle: '没有可展示的节点',
      emptyHint: '调整搜索或筛选条件后再试。',
      legend: '图谱图例',
      interactionHint: '单击检查 · 双击扩展 · 滚轮缩放',
      search: '搜索',
      viewMode: '首页展示方式',
      graph: '图谱',
      list: '列表',
      context: '上下文详情',
      trail: '知识脉络',
      narrow: '收窄',
      expandReading: '扩展阅读',
      close: '关闭详情',
      global: '全局',
      sourceCount: { one: '{{count}} 个来源', other: '{{count}} 个来源' },
      pendingSource: '待补充来源',
      inbox: '收集箱',
      library: '知识库',
      newDraft: '新草稿',
      edit: '编辑'
    },
    type: {
      identity: '人格',
      semantic: '语义',
      episodic: '情景',
      procedural: '流程',
      article: '文章',
      topic: '主题',
      tag: '标签',
      persona: '人格中心',
      scope: '作用域',
      sourceSession: '来源会话'
    },
    status: {
      candidate: '候选',
      active: '生效',
      rejected: '错误',
      superseded: '已替代',
      archived: '已归档',
      draft: '草稿',
      published: '已发布'
    },
    entity: {
      memoryCluster: '记忆聚类',
      knowledgeCluster: '知识聚类',
      noteMemory: '这是用于组织内容的关系节点。选择相连的记忆即可在这里查看正文，主图谱会保持原位。',
      noteKnowledge: '这是用于组织内容的关系节点。选择相连的文章即可在这里查看正文，主图谱会保持原位。'
    },
    memory: {
      eyebrow: '记忆图谱',
      title: '记忆脉络',
      description: '人格、工作与项目记忆，按关系聚合并保持可审阅。',
      noMatch: '没有匹配的记忆',
      empty: '还没有长期记忆',
      listAria: '记忆列表',
      titleColumn: '标题',
      classColumn: '类别',
      scopeColumn: '作用域',
      statusColumn: '状态',
      useColumn: '使用',
      lastUsedColumn: '最近使用',
      sourceColumn: '来源',
      accessCount: '{{count}} 次',
      never: '从未',
      loadMore: '再加载 100 条'
    },
    knowledge: {
      eyebrow: '知识图谱',
      title: '知识脉络',
      description: '主题连接文章与来源会话；草稿审核后再发布。',
      newDraft: '新建草稿',
      noMatch: '没有匹配的知识文章',
      firstKnowledge: '从会话中建立第一篇知识',
      noMatchHint: '换一个关键词，或切换到列表查看全部文章。',
      firstHint: '自动提炼只会生成草稿，你确认后再发布。',
      noArticle: '没有匹配的文章',
      emptyLibrary: '知识库还是空的',
      retrySearch: '调整搜索关键词后再试。',
      emptyLibraryHint: '可以手动新建草稿，也可以填写会话 ID 后让 Agent OS 提炼。',
      createFirst: '创建第一篇草稿',
      listAria: '知识文章列表',
      titleColumn: '标题',
      topicColumn: '主题',
      statusColumn: '状态',
      tagsColumn: '标签',
      publishedColumn: '发布时间',
      updatedColumn: '更新时间',
      favoriteColumn: '收藏',
      sourceColumn: '来源',
      loadMore: '再加载 100 篇'
    },
    reader: {
      back: '← 返回知识库',
      favoriteOn: '★ 已收藏',
      favoriteOff: '☆ 收藏',
      publish: '发布',
      restore: '恢复草稿',
      archive: '归档',
      edit: '编辑',
      sources: '来源会话',
      noSources: '尚未关联来源，会在发布前提醒补充。',
      comments: '本机批注',
      commentPlaceholder: '记录你的批注',
      addComment: '添加批注',
      deleteConfirm: '永久删除这篇文章及其本机批注？此操作不可恢复。',
      deleteForever: '永久删除'
    },
    editor: {
      kicker: '知识草稿',
      editTitle: '编辑文章',
      newTitle: '新建文章',
      cancel: '取消',
      title: '标题',
      titlePlaceholder: '文章标题',
      summary: '摘要',
      summaryPlaceholder: '一句话说明这篇文章解决什么问题',
      topic: '主题',
      topicPlaceholder: '例如 IoT 开发',
      tags: '标签',
      tagsPlaceholder: '逗号分隔',
      source: '来源会话',
      sourcePlaceholder: '会话 ID（发布前必填）',
      body: 'Markdown 正文',
      bodyPlaceholder: '从问题、判断和可复用结论开始写…',
      save: '保存草稿',
      extract: '使用共享 CLI 提炼',
      sharedHint: '提炼 CLI 和模型在“设置 → 记忆与知识”统一配置。',
      noCwd: '该会话缺少工作目录，无法在受限模式中提炼'
    }
  },
  vault: {
    error: {
      titleContentEmpty: '记忆标题与内容不能为空',
      sensitive: '检测到疑似密钥或凭证，已拒绝写入长期记忆',
      contentEmpty: '记忆内容不能为空',
      notFound: '记忆不存在',
      dailyDepositLimit: '今天已沉淀 1 条记忆，明天可继续新增'
    },
    gateway: {
      allCli: '所有可执行 Shell 命令的 agent 都可调用 agent-os memory',
      mcp: '支持 MCP 的 agent 可自主检索、提议与反馈',
      wrapper: '封装器传入 Context Pack 文件；需在对应 CLI 配置中显式读取'
    }
  },
  curation: {
    error: {
      noJsonObject: '记忆提炼 Agent 未返回 JSON 对象',
      jsonParseFailed: '记忆提炼 Agent 返回的 JSON 无法解析',
      notEnabled: '长期记忆生成未启用',
      externalContext: '该会话含外部上下文，默认禁止自动提炼；请先在策略中明确允许',
      noCurator: '未发现可用于提炼的 CLI（需支持结构化 headless 通道，如 pi/claude/codex）',
      timeout: '记忆提炼超时（120 秒）',
      exitCode: '记忆提炼 Agent 以 {{code}} 退出',
      noText: '记忆提炼 Agent 未返回文本'
    }
  }
}

export const en: typeof zh = {
  tab: {
    sessions: 'Sessions',
    experience: 'Experience',
    candidates: 'Candidates',
    policy: 'Policy & Access'
  },
  index: {
    building: 'Indexing… {{indexed}}/{{total}} files'
  },
  dataPlane: {
    degradedTitle: 'Some data sources are degraded',
    failedFiles: '{{count}} session files could not be parsed',
    failedFilesHint:
      'Other history sessions remain searchable; restart the app to retry failed files.'
  },
  search: {
    aria: 'Search sessions',
    placeholder: 'Search session content, titles, directories…',
    searching: 'Searching…',
    resultCount: { one: '{{count}} session', other: '{{count}} sessions' }
  },
  filter: {
    workspaceAria: 'Project filter',
    allWorkspaces: 'All projects',
    clearDateAria: 'Clear date filter',
    dateAria: 'Time filter',
    dateAll: 'All time',
    dateToday: 'Today',
    date7d: 'Last 7 days',
    date30d: 'Last 30 days'
  },
  empty: {
    buildingTitle: 'Index is building',
    buildingHint: 'History sessions will appear once parsing completes.',
    noHistoryTitle: 'No history sessions yet',
    noHistoryHint:
      'History sessions are collected automatically once you work with Claude Code, Codex, etc.',
    noMatchTitle: 'No matching sessions',
    noMatchHint: 'Try a different keyword or clear the filters.'
  },
  hit: {
    unknownCwd: 'Unknown directory',
    messageCount: { one: '{{count}} message', other: '{{count}} messages' }
  },
  detail: {
    aria: 'Session detail',
    defaultTitle: 'Memory detail',
    defaultTool: 'History session',
    closeAria: 'Close detail',
    loadingTranscript: 'Reading session transcript…',
    errorTitle: 'Memory detail unavailable',
    roleUser: 'You',
    creating: 'Creating…',
    openNew: 'Start a new session in this directory',
    curatingExp: 'Curating…',
    curateExp: 'Curate to experience',
    curating: 'Curating…',
    curateCandidate: 'Curate candidates',
    notFound: 'This memory no longer exists or has been deleted.',
    storedAt: 'Stored {{time}}',
    saveEdit: 'Save changes',
    confirmDelete: 'Confirm delete?',
    unpinAria: 'Unpin (no longer injected first)',
    pinAria: 'Pin (always inject this memory first)',
    pinned: '📌 Pinned',
    pin: '📌 Pin',
    pinnedBadge: 'Pinned',
    evidenceManual: 'Manually confirmed',
    scopeRefHint: 'If the scope is not "user", the scope reference field is shown automatically.',
    evidenceHint: 'Evidence is unchanged when editing: {{evidence}}',
    tagsLabel: 'Tags: {{tags}}',
    evidenceLabel: 'Evidence: {{evidence}}',
    createdUpdatedAt: 'Created {{created}} · Updated {{updated}}',
    createTitle: 'New memory',
    createNote:
      'Manually created memories take effect immediately and are tagged "manual". Only add stable, reusable preferences, conventions, or facts that will not expire soon.',
    field: {
      titleAria: 'Memory title',
      titlePlaceholder: 'Title',
      contentAria: 'Memory content',
      contentPlaceholder: 'Memory content',
      kindAria: 'Memory type',
      scopeAria: 'Memory scope',
      scopeRefAria: 'Scope reference',
      scopeRefAgent: 'Agent ID',
      scopeRefPath: 'Project or path',
      tagsAria: 'Memory tags',
      tagsPlaceholder: 'Tags, comma-separated'
    },
    error: {
      titleContentEmpty: 'Title and content cannot be empty',
      createFailed: 'Failed to create memory',
      notExists: 'This memory no longer exists or its state has changed',
      saveFailed: 'Failed to save memory'
    }
  },
  experience: {
    title: 'Long-term memory',
    subtitle:
      'Confirmed knowledge is recalled by scope in permitted tasks · {{count}} entries in total',
    emptyTitle: 'No confirmed long-term memory yet',
    emptyHint: 'Curate from a session detail, or confirm an agent proposal in the candidate box.',
    fromTool: 'From {{tool}}',
    confirmed: 'Confirmed',
    deleteAria: 'Delete experience: {{title}}',
    deleteTitle: 'Delete experience',
    deleteMessage: 'This cannot be undone. Delete this experience entry?'
  },
  candidates: {
    title: 'Candidate memories',
    subtitle:
      'Agents and background curation can only write here; nothing is injected into any new task before confirmation.',
    emptyTitle: 'Candidate box is empty',
    emptyHint: 'MCP-enabled agents can submit candidates via memory_propose.',
    reject: 'Reject'
  },
  policy: {
    title: 'Policy & Access',
    subtitle:
      'Memory is stored locally only. Rule files and explicit user instructions always take precedence over memory.',
    curator: 'Memory curation agent',
    noCurator: 'No CLI supporting isolated curation discovered (e.g. pi).',
    tokenBudget: 'Context Pack budget (tokens)',
    gatewayTitle: 'Agent access capabilities',
    setting: {
      enabledTitle: 'Enable Memory Vault',
      enabledDesc: 'When off, no agent receives long-term memory.',
      useMemoriesTitle: 'Allow new tasks to use memory',
      useMemoriesDesc: 'Keep memories but temporarily disable context injection.',
      generateMemoriesTitle: 'Allow background memory curation',
      generateMemoriesDesc: 'The system uses an available curator; all types and sources share one local-day slot, allowing at most one new memory per day.',
      allowExternalTitle: 'Allow external context in curation',
      allowExternalDesc: 'Off by default to avoid Web/MCP content polluting long-term memory.'
    }
  },
  notice: {
    indexStatusFailed: 'Failed to read index status: {{message}}',
    searchFailed: 'Search failed: {{message}}',
    experienceFailed: 'Failed to read experience store: {{message}}',
    vaultFailed: 'Failed to read long-term memory: {{message}}',
    noCwd: 'This history session has no usable working directory',
    createSessionFailed: 'Failed to start a new session: {{message}}',
    curatedToExperience: 'Curated to the experience store',
    curateFailed: 'Curation failed: {{message}}',
    curateNoCwd: 'This history session has no working directory; cannot safely start memory curation.',
    curateNoText: 'This session has no user or assistant text available for curation.',
    curated: 'Generated {{count}} candidate memories, pending confirmation.',
    curateEmpty: 'No stable memory found to curate.',
    curateRunFailed: 'Curation failed: {{message}}',
    confirmed: 'Candidate memory confirmed; it will be recalled in subsequent permitted tasks.',
    rejected: 'Candidate memory archived; it will not enter agent context.',
    closeAria: 'Close notice'
  },
  time: {
    justNow: 'Just now',
    minutesAgo: '{{count}} min ago',
    minutesAgoShort: '{{count}} min ago',
    hoursAgo: '{{count}} hr ago',
    hoursAbbr: '{{count}}h ago',
    daysAgo: '{{count}} d ago',
    daysAgoShort: '{{count}} d ago',
    fullDateFallback: 'Session on {{date}}'
  },
  fav: {
    favoriteOnly: '★ Favorites only',
    empty: 'No favorites or tags yet. Tap ★ to favorite or # to tag on a session or message.',
    untitled: '(Untitled)',
    messageKind: 'Message',
    starAria: 'Favorite',
    unstarAria: 'Unfavorite',
    editTagsAria: 'Edit tags',
    editMessageTags: 'Edit message tags',
    editSessionTags: 'Edit session tags'
  },
  persona: {
    title: 'User persona',
    undo: 'Revert',
    savedAt: 'Saved at {{time}}',
    globalHint: 'Manual · applies globally',
    heroTitle: 'Collaboration preferences take effect before long-term memory',
    heroDesc:
      'A stable profile of "who you are, how you work, your design philosophy". Cover communication language and style, code-tradeoff leanings, when to confirm proactively, and non-negotiable conventions.',
    editorTitle: 'User persona',
    editorMeta: 'Single global copy · manually maintained',
    charCount: { one: '{{count}} char', other: '{{count}} chars' },
    placeholder:
      'For example:\n- Reply in Chinese; keep code and proper nouns in the original.\n- Prefer minimal changes; do not refactor unrelated code.\n- Ask me before destructive actions (drop DB / force push).',
    error: {
      loadFailed: 'Failed to load user persona',
      saveFailed: 'Failed to save user persona'
    }
  },
  record: {
    starMsgAria: 'Favorite message',
    unstarMsgAria: 'Unfavorite message',
    editMsgTagsAria: 'Edit message tags',
    editMsgTagsTitle: 'Edit message tags',
    stepCount: { one: '{{count}} step', other: '{{count}} steps' },
    thinking: 'Thinking process',
    loadMore: 'Scroll up to load earlier messages',
    empty: 'No readable history',
    relayTo: 'Relay to'
  },
  storage: {
    historyConv: 'History session',
    untitled: '(Untitled)',
    searchPlaceholder: 'Search session history…',
    searchMemoryPlaceholder: 'Search long-term memory…',
    favoriteOnly: '★ Favorites only',
    noTags: 'No tags yet · tap # on a record or message to add',
    collapse: 'Collapse',
    expand: 'Expand',
    removeCondAria: 'Remove this filter',
    clearAll: 'Clear all',
    searching: 'Searching…',
    noMatch: 'No records match the filters',
    empty: 'No records yet',
    messageKind: 'Message',
    starAria: 'Favorite',
    unstarAria: 'Unfavorite',
    editTagsAria: 'Edit tags',
    sourceCli: 'CLI',
    sourceAgent: 'Chat',
    indexing: 'Indexing {{indexed}}/{{total}}',
    memoryCount: { one: '{{count}} memory', other: '{{count}} memories' },
    addMemoryAria: 'Manually create a memory',
    addMemory: '+ New',
    candidatesPending: 'candidates pending',
    reject: 'Reject',
    noMemoryMatch: 'No matching memory',
    noMemoryMatchHint: 'Try another keyword, or clear the search to see all.',
    noMemory: 'No long-term memory yet',
    noMemoryHint: 'Once curation is on, memories curated from sessions appear here automatically.',
    personaSummaryEmpty: 'Click to edit your collaboration preferences',
    modeMemory: 'Memory',
    modePersona: 'User persona',
    navSession: 'Sessions',
    navMemory: 'Memory',
    navKnowledge: 'Knowledge',
    knowledgeTitle: 'Knowledge base coming soon',
    knowledgeDesc:
      'Agents will distill sessions into Obsidian-compatible md notes. Stay tuned.',
    editMessageTags: 'Edit message tags',
    editSessionTags: 'Edit session tags',
    time: {
      all: 'All',
      today: 'Today',
      d7: '7d',
      d30: '30d'
    },
    source: {
      all: 'All',
      agent: 'Chat',
      cli: 'CLI'
    },
    filterLabel: {
      time: 'Time',
      source: 'Source',
      favorite: 'Favorite',
      tags: 'Tags'
    },
    memSource: {
      feishu: 'Feishu',
      session: 'Session',
      cli: 'CLI',
      manual: 'Manual'
    }
  },
  tagEditor: {
    empty: 'No tags yet. Type and press Enter to add.',
    removeTagAria: 'Remove tag {{tag}}',
    placeholder: 'New tag, press Enter to add'
  },
  atlas: {
    common: {
      findNode: 'Find node',
      fitCanvas: 'Fit canvas',
      hideSources: 'Hide current sources',
      showSources: 'Show current sources',
      navigator: 'Graph node navigator',
      nodePlaceholder: 'Enter a node name',
      truncated: 'Showing the {{count}} most recently active items. Search to find the rest.',
      memoryGraphAria: 'Circular memory graph. Select a node to inspect it, double-click to expand reading, drag empty space to pan, and scroll to zoom.',
      knowledgeGraphAria: 'Circular knowledge graph. Select a node to inspect it, double-click to expand reading, drag empty space to pan, and scroll to zoom.',
      emptyTitle: 'No nodes to show',
      emptyHint: 'Adjust the search or filters and try again.',
      legend: 'Graph legend',
      interactionHint: 'Select to inspect · Double-click to expand · Scroll to zoom',
      search: 'Search',
      viewMode: 'Home view',
      graph: 'Graph',
      list: 'List',
      context: 'Context details',
      trail: 'Knowledge trail',
      narrow: 'Narrow',
      expandReading: 'Expand reading',
      close: 'Close details',
      global: 'Global',
      sourceCount: { one: '{{count}} source', other: '{{count}} sources' },
      pendingSource: 'Source needed',
      inbox: 'Inbox',
      library: 'Knowledge library',
      newDraft: 'New draft',
      edit: 'Edit'
    },
    type: {
      identity: 'Identity',
      semantic: 'Semantic',
      episodic: 'Episodic',
      procedural: 'Procedure',
      article: 'Article',
      topic: 'Topic',
      tag: 'Tag',
      persona: 'Persona center',
      scope: 'Scope',
      sourceSession: 'Source session'
    },
    status: {
      candidate: 'Candidate',
      active: 'Active',
      rejected: 'Wrong',
      superseded: 'Superseded',
      archived: 'Archived',
      draft: 'Draft',
      published: 'Published'
    },
    entity: {
      memoryCluster: 'Memory cluster',
      knowledgeCluster: 'Knowledge cluster',
      noteMemory: 'This relationship node organizes content. Select a connected memory to read it here while the main graph stays in place.',
      noteKnowledge: 'This relationship node organizes content. Select a connected article to read it here while the main graph stays in place.'
    },
    memory: {
      eyebrow: 'MEMORY ATLAS',
      title: 'Memory map',
      description: 'Identity, working, and project memory grouped by relationship and kept reviewable.',
      noMatch: 'No matching memories',
      empty: 'No durable memory yet',
      listAria: 'Memory list',
      titleColumn: 'Title',
      classColumn: 'Class',
      scopeColumn: 'Scope',
      statusColumn: 'Status',
      useColumn: 'Uses',
      lastUsedColumn: 'Last used',
      sourceColumn: 'Sources',
      accessCount: '{{count}} uses',
      never: 'Never',
      loadMore: 'Load 100 more'
    },
    knowledge: {
      eyebrow: 'KNOWLEDGE ATLAS',
      title: 'Knowledge map',
      description: 'Topics connect articles to source sessions; drafts are reviewed before publishing.',
      newDraft: 'New draft',
      noMatch: 'No matching knowledge articles',
      firstKnowledge: 'Build your first article from a session',
      noMatchHint: 'Try another keyword or switch to the list to browse every article.',
      firstHint: 'Automatic curation creates a draft. You decide when to publish it.',
      noArticle: 'No matching articles',
      emptyLibrary: 'Your knowledge library is empty',
      retrySearch: 'Adjust the search and try again.',
      emptyLibraryHint: 'Create a draft, or enter a session ID and let Agent OS curate one.',
      createFirst: 'Create the first draft',
      listAria: 'Knowledge article list',
      titleColumn: 'Title',
      topicColumn: 'Topic',
      statusColumn: 'Status',
      tagsColumn: 'Tags',
      publishedColumn: 'Published',
      updatedColumn: 'Updated',
      favoriteColumn: 'Favorite',
      sourceColumn: 'Sources',
      loadMore: 'Load 100 more'
    },
    reader: {
      back: '← Back to knowledge',
      favoriteOn: '★ Favorited',
      favoriteOff: '☆ Favorite',
      publish: 'Publish',
      restore: 'Restore draft',
      archive: 'Archive',
      edit: 'Edit',
      sources: 'Source sessions',
      noSources: 'No source is linked yet. Publishing will ask you to add one.',
      comments: 'Local notes',
      commentPlaceholder: 'Write a private note',
      addComment: 'Add note',
      deleteConfirm: 'Permanently delete this article and its local notes? This cannot be undone.',
      deleteForever: 'Delete permanently'
    },
    editor: {
      kicker: 'Knowledge draft',
      editTitle: 'Edit article',
      newTitle: 'New article',
      cancel: 'Cancel',
      title: 'Title',
      titlePlaceholder: 'Article title',
      summary: 'Summary',
      summaryPlaceholder: 'Explain in one sentence what this article helps solve',
      topic: 'Topic',
      topicPlaceholder: 'For example, IoT development',
      tags: 'Tags',
      tagsPlaceholder: 'Separate with commas',
      source: 'Source session',
      sourcePlaceholder: 'Session ID (required before publishing)',
      body: 'Markdown body',
      bodyPlaceholder: 'Start with the problem, judgment, and reusable conclusion…',
      save: 'Save draft',
      extract: 'Curate with the shared CLI',
      sharedHint: 'Choose the curation CLI and model in Settings → Memory & Knowledge.',
      noCwd: 'This session has no working directory and cannot be curated in restricted mode'
    }
  },
  vault: {
    error: {
      titleContentEmpty: 'Memory title and content cannot be empty',
      sensitive: 'Detected a suspected key or credential; refused to write to long-term memory',
      contentEmpty: 'Memory content cannot be empty',
      notFound: 'Memory not found',
      dailyDepositLimit: 'One memory has already been deposited today; another can be added tomorrow'
    },
    gateway: {
      allCli: 'Any agent that can run shell commands can invoke agent-os memory',
      mcp: 'MCP-enabled agents can search, propose, and give feedback autonomously',
      wrapper: 'Wrapper passes a Context Pack file; must be read explicitly in the CLI config'
    }
  },
  curation: {
    error: {
      noJsonObject: 'Memory curation agent did not return a JSON object',
      jsonParseFailed: 'The JSON returned by the curation agent could not be parsed',
      notEnabled: 'Long-term memory generation is not enabled',
      externalContext:
        'This session contains external context; auto-curation is blocked by default. Allow it explicitly in policy first.',
      noCurator:
        'No CLI available for curation (requires a structured headless channel, e.g. pi/claude/codex)',
      timeout: 'Memory curation timed out (120s)',
      exitCode: 'Memory curation agent exited with code {{code}}',
      noText: 'Memory curation agent returned no text'
    }
  }
}
