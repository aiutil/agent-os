// 统计/成长字典（SPEC-036）。Phase 2 由 stats agent 填充。
// 含 v3/sections/stats/*（CardexPanel 39 张卡）、pages/overview/OverviewPage、
// v3/sections/chat/ActivityHeat、domains/stats/growth.ts。
// 注意：growth.ts 的 zh 值须与 tests/stats-growth.test.ts 断言逐字一致（tr 默认 zh 返回相同中文）。

export const zh = {
  // ── Cardex 卡牌图鉴（CardexPanel） ──
  cardex: {
    subtitle: 'AI 能力卡牌图鉴',
    todayCount: '今日 {{count}}',
    reachedMaxLevel: '已达最高级',
    nextLevelXpRemaining: '距离下一级还需 {{xp}} XP',
    nextToUnlock: '下一张接近解锁',
    hiddenClueCard: '隐藏线索卡',
    allUnlocked: '{{count}} 张已全部解锁',
    equippedCards: '已装备卡牌',
    emptySlot: '空槽',
    equip: '装备',
    equipped: '已装备',
    equipCard: '装备卡牌',
    unequipCard: '卸下卡牌',
    closeDetail: '关闭卡牌详情',
    closeUnlockHint: '关闭解锁提示',
    newCardUnlocked: '新卡解锁',
    insightsTitle: 'AI 洞察',
    rhythm: {
      title: '节律图谱',
      copy: '最近 90 天 AI 活跃情况。高能日、连续活跃和卡牌进度都来自这里。',
      heatAria: '最近 90 天 AI 活跃点阵',
      summaryAria: '节律摘要',
      activeDays: '活跃天',
      peakDay: '峰值日',
      streakWeeks: '连续周',
      daySuffix: '天',
      timesSuffix: '次',
      weekSuffix: '周',
      cellTitle: '{{date}}：{{count}} 条用户提示'
    },
    series: {
      interaction: '交互',
      session: '会话',
      cri: 'CRI',
      memory: '记忆',
      workbench: '工作台',
      evolution: '进化',
      rhythm: '节律',
      persona: '隐藏人格'
    },
    rarity: {
      common: '普通',
      rare: '稀有',
      epic: '史诗',
      legendary: '传说',
      mythic: '神话'
    },
    cards: {
      'ia-001': { title: '初次握手', hint: '完成第一次 AI 交互', flavor: '你开始把问题交给 AI 处理。' },
      'ia-002': { title: '十问入门', hint: '累计 30 次 AI 交互', flavor: '稳定的问题拆解意识开始出现。' },
      'ia-003': { title: '百次回路', hint: '累计 500 次 AI 交互', flavor: 'AI 已经进入你的日常工作流。' },
      'ia-004': { title: '千次神经', hint: '累计 5000 次 AI 交互', flavor: '你拥有高频反馈回路。' },
      'ia-005': { title: '深水对话者', hint: '交互、会话、记忆共同达标', flavor: '不是刷次数，而是能持续推进复杂问题。' },
      'ss-001': { title: '会话火种', hint: '完成 1 次会话', flavor: '第一条工作上下文被保存。' },
      'ss-002': { title: '多线程行者', hint: '累计 10 次会话', flavor: '你开始把任务分成多个会话处理。' },
      'ss-003': { title: '会话大师 I', hint: '累计 80 次会话', flavor: '稳定的 Agent 使用习惯已形成。' },
      'ss-004': { title: '会话大师 II', hint: '累计 300 次会话', flavor: '你能维护长期上下文。' },
      'ss-005': { title: '上下文建筑师', hint: '会话与记忆共同成长', flavor: '你不是聊天，而是在搭建知识结构。' },
      'cri-001': { title: 'CRI 公民 I', hint: '使用 10 次 CRI/CLI', flavor: '你开始在本地终端里协作。' },
      'cri-002': { title: 'CRI 公民 II', hint: '使用 80 次 CRI/CLI', flavor: 'CLI 已经成为你的默认入口。' },
      'cri-003': { title: '终端调度员', hint: '使用 300 次 CRI/CLI', flavor: '你能在多个工具间切换执行。' },
      'cri-004': { title: '本地执行官', hint: '使用 1000 次 CRI/CLI', flavor: '本地优先的执行能力成型。' },
      'cri-005': { title: '命令流术士', hint: 'CRI 与会话双指标达标', flavor: '会话和命令流可以互相接力。' },
      'mm-001': { title: '记忆种子', hint: '产生 5 条记忆', flavor: '第一块长期上下文开始沉淀。' },
      'mm-002': { title: '记忆守护者 I', hint: '产生 80 条记忆', flavor: '你的工作开始有连续性。' },
      'mm-003': { title: '记忆守护者 II', hint: '产生 300 条记忆', flavor: 'AI 能更懂你的项目脉络。' },
      'mm-004': { title: '知识晶格', hint: '产生 1000 条记忆', flavor: '碎片信息正在形成结构。' },
      'mm-005': { title: '长期上下文体', hint: '记忆与会话共同达标', flavor: '你拥有跨任务延续能力。' },
      'wb-001': { title: '工作台装配师', hint: '使用 1 个以上 CLI 工具', flavor: '工作台开始连接外部系统。' },
      'wb-002': { title: '连接器收藏家', hint: '使用 3 个以上 CLI 工具', flavor: '常用系统被纳入 Agent OS。' },
      'wb-003': { title: '控制台策展人', hint: '使用 5 个以上 CLI 工具', flavor: '你在构建个人工作驾驶舱。' },
      'wb-004': { title: '桌面中枢', hint: '工具使用和 CLI 交互共同达标', flavor: '工具、终端和上下文被放在同一张桌面上。' },
      'ev-001': { title: '版本追随者', hint: '使用过 1 种以上 CLI', flavor: '你保持软件处于演进状态。' },
      'ev-002': { title: '进化采样者', hint: '使用过 3 种以上 CLI', flavor: '你愿意跟随工具升级能力。' },
      'ev-003': { title: '早期进化体', hint: '多 CLI 使用与活跃共同达标', flavor: '你在使用中验证新能力。' },
      'ev-004': { title: '共同进化体', hint: '多工具、配置、等级共同达标', flavor: '你不是旁观用户，而是共同进化者。' },
      'rh-001': { title: '点阵初亮', hint: '最近 90 天点亮 3 个活跃日', flavor: '节律图出现第一格。' },
      'rh-002': { title: '三日节拍', hint: '最近 90 天点亮 14 个活跃日', flavor: 'AI 使用开始有节奏。' },
      'rh-003': { title: '高能日', hint: '单日交互达到 25 次', flavor: '你有过一次高密度推进。' },
      'rh-004': { title: '连续脉冲', hint: '连续活跃 6 周', flavor: '你的节奏不是偶发冲动。' },
      'rh-005': { title: '稳定燃烧', hint: '活跃天、高能日、连续性共同达标', flavor: '你的 AI 工作节律稳定燃烧。' },
      'ps-001': { title: '线索：整理者', hint: '记忆达到一定量级', flavor: '你倾向于把混乱整理成结构。' },
      'ps-002': { title: '线索：执行者', hint: '终端与会话有关', flavor: '你倾向于把想法快速变成动作。' },
      'ps-003': { title: '线索：研究者', hint: '会话深度与记忆有关', flavor: '你倾向于在问题里挖到更深一层。' },
      'ps-004': { title: '线索：架构师', hint: '多个能力同时成长', flavor: '你倾向于搭系统，而不是只完成任务。' },
      'ps-005': { title: '线索：夜航者', hint: '节律中藏着答案', flavor: '你的高能时刻会暴露一种使用人格。' },
      'ps-006': { title: '线索：共生体', hint: '所有系统指标共同达标', flavor: '当 AI 变成生活操作系统，卡牌会显形。' }
    }
  },

  // ── 成长计算（domains/stats/growth.ts，主进程 tr） ──
  growth: {
    levelTitle: {
      novice: '新手探索者',
      apprentice: '学徒',
      operator: 'Agent 操作员',
      artisan: 'CLI 工匠',
      architect: 'Prompt 架构师',
      whisperer: 'AI 密语者',
      master: '系统大师',
      transcendent: '超越者'
    },
    dimension: {
      creativity: '创造力',
      efficiency: '效率',
      consistency: '一致性',
      depth: '深度',
      breadth: '广度'
    },
    dimInsight: {
      high: {
        creativity: '你善于组合多种工具创造新工作流。',
        efficiency: '你维持着高密度的 Agent 协作节奏。',
        consistency: '你拥有稳定的使用习惯，几乎每日推进。',
        depth: '你能深入维护长期上下文与会话延续。',
        breadth: '你广泛使用多种 AI 工具，覆盖面广。'
      },
      highDefault: '该维度表现突出。',
      mid: '该维度评分 {{value}}/10，稳步成长中。',
      low: '该维度评分 {{value}}/10，仍有较大提升空间。'
    },
    achievement: {
      activeWeek: { title: '连续探索', desc: '累计活跃 7 天' },
      tenSessions: { title: '稳定搭档', desc: '累计完成 10 个会话' },
      fiftyPrompts: { title: '高频共创', desc: '累计发送 50 条提示' },
      level12: { title: 'Agent 操作员', desc: '达到 12 级' },
      level24: { title: 'CLI 工匠', desc: '达到 24 级' }
    },
    insight: {
      favoriteTool: '你最常使用 {{tool}}。',
      deepNight: '你最常在深夜使用 AI，注意劳逸结合。',
      morning: '你最常在上午使用 AI，状态充沛。',
      afternoon: '你最常在下午使用 AI。',
      evening: '你最常在晚间使用 AI。',
      topDim: '你的「{{label}}」维度突出（{{value}}/10）。'
    },
    nextLevelHint: {
      max: '已达到当前版本最高等级',
      next: '下一等级 Lv.{{level}} 需 {{xp}} XP'
    }
  },

  // ── 统计页（StatsView.tsx） ──
  view: {
    tabOverview: '总览',
    tabModels: 'Models',
    tabProjects: '项目',
    projectAll: '全部项目',
    projectSearchPlaceholder: '搜索项目名称或路径…',
    projectNotFound: '未找到匹配项目',
    updating: '更新中',
    loadingStats: '正在加载统计…',
    loadingModels: '正在加载模型统计…',
    heatCellTip: '次用户提示',
    rhythmSummaryTotal: '共',
    rhythmSummaryMid: '次用户提示 · 活跃 {{days}} 天',
    noModelData: '暂无可按模型分组的 token 数据',
    rhythm: {
      peakDay: '峰值日',
      last7: '近 7 日',
      activeRate: '活跃率',
      dailyAvg: '日均',
      userPrompts: '用户提示',
      active26w: '近 26 周'
    },
    cards: {
      sessions: '会话数',
      messages: '消息数',
      tokens: 'Token 总量',
      activeDays: '活跃天数',
      currentStreak: '连续天数',
      longestStreak: '最长连续',
      topCli: '常用 CLI',
      projects: '项目数'
    }
  },

  export: {
    csv: '导出 CSV',
    dialogTitle: '导出统计 CSV',
    success: '统计 CSV 已导出',
    failed: '导出失败，请重试'
  },

  project: {
    loading: '正在加载项目统计…',
    empty: '当前筛选范围暂无项目统计',
    unassigned: '未识别项目',
    noWorkspacePath: '无工作目录信息',
    openDetail: '查看 {{project}} 的统计详情',
    loadingDetail: '正在加载项目详情…',
    loadFailed: '项目详情加载失败，请关闭后重试',
    tokenTrend: 'Token 使用曲线',
    trendAria: '项目每日 Token 使用曲线',
    noTrend: '当前范围暂无 Token 趋势数据',
    columns: {
      project: '项目',
      sessions: '会话',
      prompts: '提示',
      tokens: 'Token',
      cost: '估算费用'
    }
  },

  // ── 成长镜头空态/加载（GrowthView.tsx） ──
  growthView: {
    disabledTitle: '成长系统已关闭',
    disabledCopy1: '开启后将根据你的使用习惯生成',
    disabledCopy2: '等级、能力维度与卡牌图鉴',
    enable: '启用成长系统',
    loading: '正在读取本地成长数据…'
  },

  // ── 统计二级面板（StatsSecPanel.tsx） ──
  secPanel: {
    stats: '统计',
    growth: '成长'
  },

  // ── 总览页（OverviewPage.tsx） ──
  overview: {
    title: '总览',
    refreshTs: '上次刷新 {{ts}}，每 30 秒自动更新',
    loadFailed: '加载失败',
    sessions: {
      title: '运行中会话',
      viewAll: '全部 →',
      empty: '暂无运行中会话'
    },
    activity: {
      title: '近 30 日活跃',
      cellTitle: '{{date}} · {{count}} 条',
      activePrefix: '活跃',
      streakPrefix: '连续',
      totalPrefix: '共',
      dayUnit: '天',
      countUnit: '条'
    },
    tools: {
      title: 'CLI 工具',
      openSettings: '设置 →',
      updatable: '可升级'
    },
    dataHealth: {
      title: '数据面健康',
      statusOk: '正常',
      statusPartial: '部分',
      statusDrifted: '漂移',
      statusUnknown: '未测',
      notChecked: '尚未检测'
    },
    runtime: {
      title: '运行时',
      modeLabel: '模式',
      modeDaemon: 'Daemon',
      modeInProcess: '进程内',
      connectionLabel: '连接',
      connConnected: '已连接',
      connHandshaking: '握手中',
      connSpawning: '启动中',
      connDegraded: '降级',
      sessionCount: '会话数',
      fallbackReason: '降级原因'
    }
  },

  // ── 会话镜头底部热力（ActivityHeat.tsx） ──
  activity: {
    interactions: '{{count}} 次交互',
    streak: '连续 {{count}} 天 🔥'
  }
}

export const en: typeof zh = {
  cardex: {
    subtitle: 'AI capability card codex',
    todayCount: 'Today {{count}}',
    reachedMaxLevel: 'Max level reached',
    nextLevelXpRemaining: '{{xp}} XP to next level',
    nextToUnlock: 'Next to unlock',
    hiddenClueCard: 'Hidden clue card',
    allUnlocked: 'All {{count}} cards unlocked',
    equippedCards: 'Equipped cards',
    emptySlot: 'Empty slot',
    equip: 'Equip',
    equipped: 'Equipped',
    equipCard: 'Equip card',
    unequipCard: 'Unequip card',
    closeDetail: 'Close card detail',
    closeUnlockHint: 'Close unlock notice',
    newCardUnlocked: 'New card unlocked',
    insightsTitle: 'AI Insights',
    rhythm: {
      title: 'Rhythm map',
      copy: 'AI activity over the last 90 days. High-energy days, continuous activity, and card progress all come from here.',
      heatAria: 'AI activity grid for the last 90 days',
      summaryAria: 'Rhythm summary',
      activeDays: 'Active days',
      peakDay: 'Peak day',
      streakWeeks: 'Streak weeks',
      daySuffix: 'd',
      timesSuffix: '×',
      weekSuffix: 'w',
      cellTitle: '{{date}}: {{count}} user prompts'
    },
    series: {
      interaction: 'Interaction',
      session: 'Session',
      cri: 'CRI',
      memory: 'Memory',
      workbench: 'Workbench',
      evolution: 'Evolution',
      rhythm: 'Rhythm',
      persona: 'Hidden Persona'
    },
    rarity: {
      common: 'Common',
      rare: 'Rare',
      epic: 'Epic',
      legendary: 'Legendary',
      mythic: 'Mythic'
    },
    cards: {
      'ia-001': { title: 'First Handshake', hint: 'Complete your first AI interaction', flavor: 'You start handing questions over to AI.' },
      'ia-002': { title: 'Ten-Question Initiate', hint: 'Reach 30 AI interactions', flavor: 'A steady habit of breaking problems apart is emerging.' },
      'ia-003': { title: 'Hundred-Circuit', hint: 'Reach 500 AI interactions', flavor: 'AI has entered your daily workflow.' },
      'ia-004': { title: 'Thousand-Neuron', hint: 'Reach 5000 AI interactions', flavor: 'You run a high-frequency feedback loop.' },
      'ia-005': { title: 'Deep-Water Converser', hint: 'Interactions, sessions, and memory all on target', flavor: 'Not grinding counts, but steadily pushing complex problems forward.' },
      'ss-001': { title: 'Session Spark', hint: 'Complete 1 session', flavor: 'The first work context is saved.' },
      'ss-002': { title: 'Multi-Thread Walker', hint: 'Reach 10 sessions', flavor: 'You start splitting tasks across sessions.' },
      'ss-003': { title: 'Session Master I', hint: 'Reach 80 sessions', flavor: 'A stable agent usage habit has formed.' },
      'ss-004': { title: 'Session Master II', hint: 'Reach 300 sessions', flavor: 'You can maintain long-term context.' },
      'ss-005': { title: 'Context Architect', hint: 'Sessions and memory grow together', flavor: "You're not chatting, you're building a knowledge structure." },
      'cri-001': { title: 'CRI Citizen I', hint: 'Use CRI/CLI 10 times', flavor: 'You start collaborating inside the local terminal.' },
      'cri-002': { title: 'CRI Citizen II', hint: 'Use CRI/CLI 80 times', flavor: 'CLI has become your default entry point.' },
      'cri-003': { title: 'Terminal Dispatcher', hint: 'Use CRI/CLI 300 times', flavor: 'You can switch execution across multiple tools.' },
      'cri-004': { title: 'Local Executive', hint: 'Use CRI/CLI 1000 times', flavor: 'A local-first execution capability has taken shape.' },
      'cri-005': { title: 'Command-Flow Mage', hint: 'CRI and session both on target', flavor: 'Sessions and command flows can relay each other.' },
      'mm-001': { title: 'Memory Seed', hint: 'Generate 5 memories', flavor: 'The first block of long-term context starts to settle.' },
      'mm-002': { title: 'Memory Keeper I', hint: 'Generate 80 memories', flavor: 'Your work starts to have continuity.' },
      'mm-003': { title: 'Memory Keeper II', hint: 'Generate 300 memories', flavor: 'AI understands your project thread better.' },
      'mm-004': { title: 'Knowledge Lattice', hint: 'Generate 1000 memories', flavor: 'Fragmented information is forming structure.' },
      'mm-005': { title: 'Long-Context Being', hint: 'Memory and session both on target', flavor: 'You have cross-task continuity.' },
      'wb-001': { title: 'Workbench Assembler', hint: 'Use 1+ CLI tools', flavor: 'The workbench starts connecting external systems.' },
      'wb-002': { title: 'Connector Collector', hint: 'Use 3+ CLI tools', flavor: 'Common systems are brought into Agent OS.' },
      'wb-003': { title: 'Console Curator', hint: 'Use 5+ CLI tools', flavor: "You're building a personal work cockpit." },
      'wb-004': { title: 'Desktop Hub', hint: 'Tool usage and CLI interaction both on target', flavor: 'Tools, terminal, and context share one desktop.' },
      'ev-001': { title: 'Version Follower', hint: 'Use 1+ CLI types', flavor: 'You keep software in an evolving state.' },
      'ev-002': { title: 'Evolution Sampler', hint: 'Use 3+ CLI types', flavor: 'You are willing to follow tool upgrades.' },
      'ev-003': { title: 'Early Evolver', hint: 'Multi-CLI usage and activity both on target', flavor: 'You validate new capabilities through use.' },
      'ev-004': { title: 'Co-Evolver', hint: 'Multi-tool, config, and level all on target', flavor: "You're not a bystander, you're a co-evolver." },
      'rh-001': { title: 'First Pixel Lit', hint: 'Light up 3 active days in the last 90', flavor: 'The rhythm grid shows its first cell.' },
      'rh-002': { title: 'Three-Day Beat', hint: 'Light up 14 active days in the last 90', flavor: 'Your AI usage starts to find a rhythm.' },
      'rh-003': { title: 'High-Energy Day', hint: 'Reach 25 interactions in a single day', flavor: 'You had one high-density push.' },
      'rh-004': { title: 'Continuous Pulse', hint: 'Stay active 6 weeks in a row', flavor: 'Your rhythm is not a one-off burst.' },
      'rh-005': { title: 'Steady Burn', hint: 'Active days, peak day, and continuity all on target', flavor: 'Your AI work rhythm burns steadily.' },
      'ps-001': { title: 'Clue: Organizer', hint: 'Memory reaches a certain scale', flavor: 'You tend to turn chaos into structure.' },
      'ps-002': { title: 'Clue: Executor', hint: 'Terminal and session correlate', flavor: 'You tend to turn ideas into action fast.' },
      'ps-003': { title: 'Clue: Researcher', hint: 'Session depth and memory correlate', flavor: 'You tend to dig one layer deeper into problems.' },
      'ps-004': { title: 'Clue: Architect', hint: 'Multiple capabilities grow at once', flavor: 'You tend to build systems, not just finish tasks.' },
      'ps-005': { title: 'Clue: Night Voyager', hint: 'The rhythm hides an answer', flavor: 'Your peak moments expose a usage persona.' },
      'ps-006': { title: 'Clue: Symbiote', hint: 'All system metrics on target', flavor: 'When AI becomes a life OS, the cards reveal themselves.' }
    }
  },

  growth: {
    levelTitle: {
      novice: 'Novice Explorer',
      apprentice: 'Apprentice',
      operator: 'Agent Operator',
      artisan: 'CLI Artisan',
      architect: 'Prompt Architect',
      whisperer: 'AI Whisperer',
      master: 'System Master',
      transcendent: 'Transcendent'
    },
    dimension: {
      creativity: 'Creativity',
      efficiency: 'Efficiency',
      consistency: 'Consistency',
      depth: 'Depth',
      breadth: 'Breadth'
    },
    dimInsight: {
      high: {
        creativity: 'You are good at combining tools to create new workflows.',
        efficiency: 'You sustain a high-density agent collaboration pace.',
        consistency: 'You have a stable usage habit, advancing almost daily.',
        depth: 'You can deeply maintain long-term context and session continuity.',
        breadth: 'You broadly use many AI tools with wide coverage.'
      },
      highDefault: 'This dimension stands out.',
      mid: 'This dimension scores {{value}}/10, growing steadily.',
      low: 'This dimension scores {{value}}/10, with room to grow.'
    },
    achievement: {
      activeWeek: { title: 'Continuous Exploration', desc: 'Active 7 days cumulative' },
      tenSessions: { title: 'Steady Partner', desc: 'Complete 10 sessions cumulative' },
      fiftyPrompts: { title: 'High-Frequency Co-Creation', desc: 'Send 50 prompts cumulative' },
      level12: { title: 'Agent Operator', desc: 'Reach level 12' },
      level24: { title: 'CLI Artisan', desc: 'Reach level 24' }
    },
    insight: {
      favoriteTool: 'You most often use {{tool}}.',
      deepNight: 'You often use AI late at night—mind your work-life balance.',
      morning: 'You often use AI in the morning, full of energy.',
      afternoon: 'You often use AI in the afternoon.',
      evening: 'You often use AI in the evening.',
      topDim: 'Your “{{label}}” dimension stands out ({{value}}/10).'
    },
    nextLevelHint: {
      max: 'Highest level for this version reached',
      next: 'Next level Lv.{{level}} needs {{xp}} XP'
    }
  },

  view: {
    tabOverview: 'Overview',
    tabModels: 'Models',
    tabProjects: 'Projects',
    projectAll: 'All projects',
    projectSearchPlaceholder: 'Search project name or path…',
    projectNotFound: 'No matching projects',
    updating: 'Updating',
    loadingStats: 'Loading stats…',
    loadingModels: 'Loading model stats…',
    heatCellTip: 'user prompts',
    rhythmSummaryTotal: '',
    rhythmSummaryMid: 'user prompts · active {{days}} days',
    noModelData: 'No token data available to group by model',
    rhythm: {
      peakDay: 'Peak day',
      last7: 'Last 7 days',
      activeRate: 'Active rate',
      dailyAvg: 'Daily avg',
      userPrompts: 'user prompts',
      active26w: 'Last 26 weeks'
    },
    cards: {
      sessions: 'Sessions',
      messages: 'Messages',
      tokens: 'Total tokens',
      activeDays: 'Active days',
      currentStreak: 'Current streak',
      longestStreak: 'Longest streak',
      topCli: 'Top CLI',
      projects: 'Projects'
    }
  },

  export: {
    csv: 'Export CSV',
    dialogTitle: 'Export statistics CSV',
    success: 'Statistics CSV exported',
    failed: 'Export failed. Try again'
  },

  project: {
    loading: 'Loading project statistics…',
    empty: 'No project statistics in the current range',
    unassigned: 'Unassigned project',
    noWorkspacePath: 'No workspace path',
    openDetail: 'View statistics for {{project}}',
    loadingDetail: 'Loading project details…',
    loadFailed: 'Could not load project details. Close and try again',
    tokenTrend: 'Token usage trend',
    trendAria: 'Daily project token usage trend',
    noTrend: 'No token trend data in the current range',
    columns: {
      project: 'Project',
      sessions: 'Sessions',
      prompts: 'Prompts',
      tokens: 'Tokens',
      cost: 'Est. cost'
    }
  },

  growthView: {
    disabledTitle: 'Growth system is off',
    disabledCopy1: 'When enabled, it generates level, capability',
    disabledCopy2: 'dimensions, and card codex from your usage',
    enable: 'Enable growth system',
    loading: 'Reading local growth data…'
  },

  secPanel: {
    stats: 'Stats',
    growth: 'Growth'
  },

  overview: {
    title: 'Overview',
    refreshTs: 'Last refreshed {{ts}}, auto-updates every 30s',
    loadFailed: 'Failed to load',
    sessions: {
      title: 'Running sessions',
      viewAll: 'All →',
      empty: 'No running sessions'
    },
    activity: {
      title: 'Last 30 days active',
      cellTitle: '{{date}} · {{count}}',
      activePrefix: 'Active',
      streakPrefix: 'Streak',
      totalPrefix: 'Total',
      dayUnit: 'd',
      countUnit: ''
    },
    tools: {
      title: 'CLI tools',
      openSettings: 'Settings →',
      updatable: 'Updatable'
    },
    dataHealth: {
      title: 'Data plane health',
      statusOk: 'OK',
      statusPartial: 'Partial',
      statusDrifted: 'Drifted',
      statusUnknown: 'Not tested',
      notChecked: 'Not checked yet'
    },
    runtime: {
      title: 'Runtime',
      modeLabel: 'Mode',
      modeDaemon: 'Daemon',
      modeInProcess: 'In-process',
      connectionLabel: 'Connection',
      connConnected: 'Connected',
      connHandshaking: 'Handshaking',
      connSpawning: 'Spawning',
      connDegraded: 'Degraded',
      sessionCount: 'Sessions',
      fallbackReason: 'Fallback reason'
    }
  },

  activity: {
    interactions: '{{count}} interactions',
    streak: '{{count}}-day streak 🔥'
  }
}
