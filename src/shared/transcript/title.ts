// 会话标题净化：从原始 transcript 文本剥离非人类标记与 XML 包装，得到适合做列表标题的人类可读文本。
// 纯函数、零依赖，供主进程（索引期写入）与渲染端（展示期兜底）共用。
// 非人类标记口径对齐 renderer/pages/workbench/chat-model.ts 的 shouldHideTranscriptMessage / transcriptProcessStep。

// 整块剥离的非人类包装（连同其内部内容一起去掉）。
const WRAPPER_BLOCK_RE: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<command-name>[\s\S]*?<\/command-name>/gi,
  /<command-message>[\s\S]*?<\/command-message>/gi,
  /<command-args>[\s\S]*?<\/command-args>/gi,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gi,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
  // SPEC-035：codex 注入的环境/指令上下文，并非用户键入内容，整块剥离避免污染标题。
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /<user_instructions>[\s\S]*?<\/user_instructions>/gi
]

// 残缺 / 无闭合的包装起止标记。
const WRAPPER_TAG_RE = /<\/?(?:system-reminder|command-name|command-message|command-args|local-command-[a-z]+|environment_context|user_instructions)\b[^>]*>/gi
// [unsupported: xxx] 占位（adapter 对未知 record 的降级文本）。
const UNSUPPORTED_RE = /\[unsupported:\s*[\w.-]+\]/gi
// 其余任意 XML 样式标签：去标签留内部文字（仅匹配带闭合 `>` 的完整标签，避免误伤 "a < b"）。
const GENERIC_TAG_RE = /<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/gi
// 文件名式伪标题：时间戳-UUID、纯 UUID、agent-xxx.meta 等。
const FILENAME_TITLE_RE = /^(?:\d{4}-\d{2}-\d{2}T[\dT\-:.Z]+_)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\.meta)?$/i
const META_FILE_RE = /^agent-[0-9a-f]+\.meta$/i
// 系统兜底文本（<local-command-caveat> 无闭合时残留）。
const CAVEAT_PREFIX_RE = /^Caveat:\s/i
// codex / Agent OS 注入的前导上下文，并非用户键入，整体视为伪标题。
const CODEX_INJECTION_RE = /^#\s*(?:AGENTS\.md\s+instructions|用户画像|Agent OS 长期记忆)(?:\s|$)/i
// 各 CLI 的空白会话默认名。
const DEFAULT_SESSION_NAME_RE = /^(?:new|untitled)\s+(?:session|chat)(?:\s*[-·:]\s*.*)?$/i
const SERIALIZED_USER_BLOCK_RE = /(?:^|\s)##\s*user\s+([\s\S]*?)(?=(?:\s##\s*(?:assistant|user|system)\b)|$)/gi
const GREETING_RE = /^(?:hi|hello|hey|你好|您好|嗨|哈喽)[!！,.，。\s]*$/i
const LEADING_GREETING_RE = /^(?:hi|hello|hey|你好|您好|嗨|哈喽)[!！,.，。:\s]+/i

function firstSerializedUserIntent(value: string): string {
  let first = ''
  for (const match of value.matchAll(SERIALIZED_USER_BLOCK_RE)) {
    const candidate = match[1]?.replace(/\s+/g, ' ').trim() ?? ''
    if (!candidate) continue
    if (!first) first = candidate
    if (!GREETING_RE.test(candidate)) return candidate
  }
  return first
}

/** 标题层纵深防御：只遮罩值，不保留可能误导用户的明文凭据。 */
function redactCredentialValues(value: string): string {
  return value
    .replace(
      /((?:密码|口令)\s*[:=：]\s*)([^\s,，;；]+)/gi,
      '$1••••'
    )
    .replace(
      /((?:password|passwd|token|api[_ -]?key|secret|access[_ -]?key)\s*[:=]\s*)([^\s,;]+)/gi,
      '$1••••'
    )
    .replace(/(bearer\s+)([a-z0-9._~+/-]+=*)/gi, '$1••••')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s@]+)(@)/gi, '$1••••$3')
}

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('')
}

/**
 * 净化单条候选文本为标题。若净化后无人类可读内容则返回 ''（调用方据此跳到下一候选）。
 */
export function sanitizeTranscriptTitle(raw: string | null | undefined, maxLength = 80): string {
  if (!raw) return ''
  let t = raw
  for (const re of WRAPPER_BLOCK_RE) t = t.replace(re, ' ')
  t = t.replace(WRAPPER_TAG_RE, ' ')
  t = t.replace(UNSUPPORTED_RE, ' ')
  t = t.replace(GENERIC_TAG_RE, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const serializedIntent = firstSerializedUserIntent(t)
  if (serializedIntent) t = serializedIntent
  t = t.replace(LEADING_GREETING_RE, '').trim()
  t = redactCredentialValues(t)
  if (GREETING_RE.test(t)) return ''
  // 过滤文件名式伪标题、系统兜底文本与 codex 注入上下文。
  if (
    FILENAME_TITLE_RE.test(t) ||
    META_FILE_RE.test(t) ||
    CAVEAT_PREFIX_RE.test(t) ||
    CODEX_INJECTION_RE.test(t) ||
    DEFAULT_SESSION_NAME_RE.test(t)
  )
    return ''
  return truncate(t, maxLength)
}

/** 候选文本是否为人类可读内容（非纯包装/工具/系统标记）。 */
export function isHumanTranscriptText(raw: string | null | undefined): boolean {
  return sanitizeTranscriptTitle(raw, 1).length > 0
}

/**
 * 推导会话标题：优先用干净来源（summary / session.title），否则用第一条人类消息，再否则回落文件名。
 * fallback 视为已可信（文件名/兜底），仅截断不剥标签，且永不返回空。
 */
export function deriveTranscriptTitle(input: {
  preferred?: string | null
  firstHumanText?: string | null
  fallback: string
  maxLength?: number
}): string {
  const max = input.maxLength ?? 80
  const preferred = sanitizeTranscriptTitle(input.preferred, max)
  if (preferred) return preferred
  const human = sanitizeTranscriptTitle(input.firstHumanText, max)
  if (human) return human
  const fallback = (input.fallback ?? '').trim()
  return truncate(fallback, max) || input.fallback
}

// SPEC-035：系统占位/模板名兜底正则（用于无 nameProvisional 字段的旧记录）。
// 与各创建点的模板名保持一致：CompareView「对比 · X」、channels manager「飞书 私聊/群聊」、
// channels router「<platform> · …xxxxxx」、空白新建「未命名会话/未命名终端/新会话」。
const PROVISIONAL_NAME_RE: RegExp[] = [
  /^未命名会话$/,
  /^未命名终端$/,
  /^新会话$/,
  /^对比 · .+/,
  /^飞书 (?:私聊|群聊)$/,
  /^[a-z][a-z0-9]* · ….+/i
]

/** 只判断名字本身是否为系统占位/已知噪声，不受历史布尔标记影响。 */
export function isSystemGeneratedSessionName(
  name: string | null | undefined,
  options?: { workspaceBase?: string }
): boolean {
  const n = (name ?? '').trim()
  if (!n || /(?:^|\s)##\s*(?:user|assistant|system)\b/i.test(n) || !sanitizeTranscriptTitle(n)) return true
  const base = options?.workspaceBase?.trim()
  if (base && (n === `${base} 会话` || n === `${base} 终端`)) return true
  return PROVISIONAL_NAME_RE.some((re) => re.test(n))
}

/** 自动回写策略：尊重用户终态名，但允许修复被错误标为终态的已知系统标题。 */
export function shouldAutoRenameSessionName(
  name: string | null | undefined,
  options?: { nameProvisional?: boolean; workspaceBase?: string }
): boolean {
  return Boolean(options?.nameProvisional) || isSystemGeneratedSessionName(name, options)
}

/**
 * 判定会话名是否为系统占位/模板名（允许被首条真实意图自动覆盖）。
 * 优先用持久化的 nameProvisional 字段；缺省（旧记录）时按模板正则 + 工作目录派生名兜底。
 */
export function isProvisionalSessionName(
  name: string | null | undefined,
  options?: { nameProvisional?: boolean; workspaceBase?: string }
): boolean {
  const n = (name ?? '').trim()
  if (!n) return true
  // 文件名/时间戳-UUID/纯包装等噪声名永远视为占位——即使曾被错误标记为 final
  // （如解析 bug 期把坏标题锁死），也允许被真实标题覆盖，修复历史坏数据。
  if (!sanitizeTranscriptTitle(n)) return true
  if (options?.nameProvisional !== undefined) return options.nameProvisional
  return isSystemGeneratedSessionName(n, options)
}

/** 会话/CLI 全 UI 统一展示标题：可信持久化名 → 首条用户意图 → 明确兜底。 */
export function deriveSessionDisplayTitle(input: {
  name?: string | null
  workspaceBase?: string
  firstUserText?: string | null
  fallback: string
  maxLength?: number
}): string {
  const max = input.maxLength ?? 80
  const rawName = input.name?.replace(/^(?:会话|CLI|终端|Chat|Terminal)\s*·\s*/i, '')
  const trustedName = isSystemGeneratedSessionName(rawName, {
    workspaceBase: input.workspaceBase
  })
    ? ''
    : sanitizeTranscriptTitle(rawName, max)
  if (trustedName) return trustedName
  const userTitle = sanitizeTranscriptTitle(input.firstUserText, max)
  if (userTitle) return userTitle
  return truncate(input.fallback.trim(), max) || input.fallback
}
