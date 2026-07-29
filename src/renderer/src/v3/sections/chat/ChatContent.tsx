// 会话镜头主内容（接活）。UI 严格复刻 V3 原型 HeroView / ChatView，
// 仅复用功能层：sessionsStore、chat-model（数据逻辑）、window.agentOs.chat（IPC）。
// 不使用任何旧 UI 组件。

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnnotationTargetRef,
  ChatTurnState,
  ManagedChatMessage,
  ManagedQueuedTurn,
  ManagedChatTimelineItem,
  MemoryTranscriptMeta,
  NormalizedMessage,
  PermissionDecision,
  ToolModelInfo,
  WorkbenchSessionView
} from '@shared/types'
import { annotationTargetKey } from '@shared/types'
import { useSessionsStore } from '../../../stores/sessionsStore'
import { useToolsStore } from '../../../stores/toolsStore'
import { useUiStore } from '../../../stores/uiStore'
import { useAnnotationsStore } from '../../../stores/annotationsStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { TagEditor } from '../storage/TagEditor'
import {
  appendUserMessage,
  applyAgentEvent,
  compactOutput,
  managedItems,
  processStatusText,
  transcriptHistoryItems,
  timelineItems,
  toolSummary,
  transcriptItems,
  upsertTimelineItem,
  type ChatItem,
  type ProcessStep
} from '../../../pages/workbench/chat-model'
import {
  attachTerminalSession,
  detachTerminalSession,
  fitTerminalSession
} from '../../../lib/terminalRegistry'
import { useContentHighlight } from '../../../lib/useContentHighlight'
import { BRAND_COLORS, ToolIcon } from '../../../lib/toolIcons'
import { sessionStatusColor } from '../../../lib/status'
import { ToolSelector } from '../../shared/ToolSelector'
import { BackendPicker } from '../../shared/BackendPicker'
import { OriginBadge } from '../../shared/OriginBadge'
import { WorkspaceSelector } from '../../shared/WorkspaceSelector'
import { ModelPicker } from '../../shared/ModelPicker'
import { RelayTrigger } from '../../shared/RelayTrigger'
import { InPageSearch } from '../../shared/InPageSearch'
import { useSessionLaunch } from './useSessionLaunch'
import { shouldAutoFollowChatScroll } from '@shared/chat-scroll'
import { isPreviewableAttachmentImage } from '@shared/attachment-preview'
import { Markdown } from '../../../lib/markdown/Markdown'
import { useT } from '../../../lib/i18n'
import { sessionDisplayTitle } from '../../../lib/sessionTitle'
import { AttachmentPreviewItem } from './AttachmentPreviewItem'

function itemId(): string {
  return crypto.randomUUID()
}

function basename(path: string): string {
  if (!path) return '~'
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

/** 附件项：path 提交给 CLI，displayName 用于 UI chip。 */
interface AttachedFile {
  path: string
  displayName: string
}

interface DraftAttachment {
  id: string
  displayName: string
  path?: string
  bytes?: Uint8Array
}

/** 单个附件大小上限（粘贴/拖拽场景足够，超出前端拒绝）。 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
function attachmentTypeAllowed(
  name: string,
  images: boolean,
  files: boolean,
  allowedExtensions?: string[]
): boolean {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (
    allowedExtensions?.length &&
    !allowedExtensions.some((allowed) => allowed.toLowerCase() === extension)
  ) {
    return false
  }
  return isPreviewableAttachmentImage(name) ? images : files
}

/** 追加附件并按 path 去重。 */
function addAttachment(cur: AttachedFile[], next: AttachedFile): AttachedFile[] {
  return cur.some((c) => c.path === next.path) ? cur : [...cur, next]
}

function addDraftAttachment(current: DraftAttachment[], next: DraftAttachment): DraftAttachment[] {
  return next.path && current.some((item) => item.path === next.path) ? current : [...current, next]
}

function fitAttachmentLimit<T>(
  currentCount: number,
  candidates: T[],
  maxFiles?: number
): { accepted: T[]; limited: boolean } {
  if (maxFiles == null) return { accepted: candidates, limited: false }
  const remaining = Math.max(0, maxFiles - currentCount)
  return {
    accepted: candidates.slice(0, remaining),
    limited: candidates.length > remaining
  }
}

function toolColor(toolId: string): string {
  return BRAND_COLORS[toolId] ?? 'var(--text-muted)'
}

const DETAIL_AGENT_ICON_SIZE = 18
const DETAIL_HEADER_TOOL_ICON_SIZE = 20

// ─── Hero 空态（严格复刻原型 HeroView 的 composer） ─────────────────────────────

function ChatHero({
  onOpenSession
}: {
  onOpenSession(view: WorkbenchSessionView): void
}): React.JSX.Element {
  const mode = useUiStore((s) => s.workbenchMode)
  const userName = useUiStore((s) => s.platform?.userName ?? 'Agent OS')
  const { t } = useT()
  const {
    engineId,
    setEngineId,
    modelId,
    setModelId,
    reasoningEffort,
    setReasoningEffort,
    toolOptions,
    workspaceOptions,
    workspacePath,
    selectProject,
    pickFolder,
    launch,
    loading,
    runtimeHostId,
    backendSections,
    backendSelection,
    setBackend
  } = useSessionLaunch(mode)
  // 0 节点时仅一节「本机」→ 保留原 ToolSelector（本机链路逐字节不变）。
  const useUnified = backendSections.length > 1
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [selectedModelInfo, setSelectedModelInfo] = useState<ToolModelInfo>()
  const runtimes = useToolsStore((state) => state.runtimes)
  const runtime = runtimes.find(
    (candidate) =>
      candidate.toolId === engineId && (candidate.runtimeHostId ?? 'local') === runtimeHostId
  )
  const attachmentCapabilities = runtime?.capabilities.attachments
  const modelModalities = selectedModelInfo?.inputModalities
  const canAttachImages =
    attachmentCapabilities?.images === true &&
    (!modelModalities || modelModalities.includes('image'))
  const canAttachFiles =
    attachmentCapabilities?.files === true &&
    (!modelModalities || modelModalities.includes('file') || modelModalities.includes('pdf'))
  const canAttach =
    mode === 'chat' && runtimeHostId === 'local' && (canAttachImages || canAttachFiles)
  const fitHeroAttachments = <T,>(candidates: T[]): T[] => {
    const { accepted, limited } = fitAttachmentLimit(
      attachments.length,
      candidates,
      attachmentCapabilities?.maxFiles
    )
    if (limited) {
      useNotificationStore.getState().show({
        message: t('chat.attach.tooMany', {
          count: attachmentCapabilities?.maxFiles ?? 0
        }),
        tone: 'warning'
      })
    }
    return accepted
  }

  useEffect(() => {
    setAttachments([])
  }, [engineId, runtimeHostId, mode])

  const addBrowserFile = async (file: File): Promise<void> => {
    if (
      !attachmentTypeAllowed(
        file.name,
        canAttachImages,
        canAttachFiles,
        attachmentCapabilities?.allowedExtensions
      )
    ) {
      useNotificationStore
        .getState()
        .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
      return
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      useNotificationStore.getState().show({ message: t('chat.attach.tooLarge'), tone: 'warning' })
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    setAttachments((current) =>
      addDraftAttachment(current, {
        id: itemId(),
        displayName: file.name || 'pasted.png',
        bytes
      })
    )
  }

  const handleHeroPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const clipboardItems = Array.from(event.clipboardData?.items ?? [])
    if (!clipboardItems.some((item) => item.kind === 'file')) return
    const files = clipboardItems
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    event.preventDefault()
    if (!canAttach) {
      useNotificationStore
        .getState()
        .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
      return
    }
    void (async () => {
      const paths = await window.agentOs.attachments.readClipboardFiles()
      if (paths.length) {
        const supportedPaths = paths.filter((path) =>
          attachmentTypeAllowed(
            path,
            canAttachImages,
            canAttachFiles,
            attachmentCapabilities?.allowedExtensions
          )
        )
        if (supportedPaths.length !== paths.length) {
          useNotificationStore
            .getState()
            .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
        }
        const acceptedPaths = fitHeroAttachments(supportedPaths)
        setAttachments((current) =>
          acceptedPaths.reduce(
            (next, path) =>
              addDraftAttachment(next, {
                id: path,
                path,
                displayName: basename(path)
              }),
            current
          )
        )
        return
      }
      const supportedFiles = files.filter((file) =>
        attachmentTypeAllowed(
          file.name,
          canAttachImages,
          canAttachFiles,
          attachmentCapabilities?.allowedExtensions
        )
      )
      if (supportedFiles.length !== files.length) {
        useNotificationStore
          .getState()
          .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
      }
      for (const file of fitHeroAttachments(supportedFiles)) await addBrowserFile(file)
    })()
  }

  const handleHeroDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!files.length) return
    event.preventDefault()
    if (!canAttach) {
      useNotificationStore
        .getState()
        .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
      return
    }
    void (async () => {
      const supportedFiles = files.filter((file) =>
        attachmentTypeAllowed(
          file.name,
          canAttachImages,
          canAttachFiles,
          attachmentCapabilities?.allowedExtensions
        )
      )
      if (supportedFiles.length !== files.length) {
        useNotificationStore
          .getState()
          .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
      }
      for (const file of fitHeroAttachments(supportedFiles)) await addBrowserFile(file)
    })()
  }

  const handleSend = (): void => {
    if (mode === 'cli') {
      void launch().then((created) => {
        if (created) onOpenSession(created)
      })
      return
    }
    if (!input.trim() || loading) return
    const text = input
    void launch(
      text,
      attachments.map(({ displayName, path, bytes }) => ({ displayName, path, bytes }))
    ).then((created) => {
      if (created) {
        setInput('')
        setAttachments([])
        onOpenSession(created)
      }
    })
  }

  return (
    <div className="hero">
      <div className="hero-title">
        {t('chat.hero.titlePrefix')}
        <b>{userName}</b>
      </div>
      <div
        className={`composer ${mode === 'cli' ? 'composer--cli' : ''}`}
        onDragOver={(event) => {
          if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
        }}
        onDrop={handleHeroDrop}
      >
        <textarea
          className="composer-input"
          placeholder={
            mode === 'cli' ? t('chat.hero.placeholderCli') : t('chat.hero.placeholderChat')
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={handleHeroPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && mode === 'chat') {
              e.preventDefault()
              handleSend()
            }
          }}
          disabled={mode === 'cli'}
        />
        {attachments.length > 0 && (
          <div className="chat-attached-files">
            {attachments.map((attachment) => (
              <AttachmentPreviewItem
                key={attachment.id}
                attachment={attachment}
                onRemove={() =>
                  setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                }
              />
            ))}
          </div>
        )}
        <div className="composer-footer">
          {useUnified ? (
            <BackendPicker
              sections={backendSections}
              value={backendSelection}
              onChange={setBackend}
              placement="up"
            />
          ) : (
            <ToolSelector value={engineId} onChange={setEngineId} tools={toolOptions} />
          )}
          <ModelPicker
            toolId={engineId}
            hostId={runtimeHostId}
            hostRemote={runtimeHostId !== 'local'}
            value={modelId}
            onChange={setModelId}
            onModelInfoChange={setSelectedModelInfo}
            reasoningValue={reasoningEffort}
            onReasoningChange={setReasoningEffort}
            placement="up"
          />
          <WorkspaceSelector
            value={workspacePath || null}
            onChange={(key) => selectProject(key)}
            workspaces={workspaceOptions}
            onAddProject={pickFolder}
            allowManualPath={runtimeHostId !== 'local'}
            addProjectLabel={
              runtimeHostId !== 'local' ? t('channels.workspace.browseRemote') : undefined
            }
            keepOpenOnAddProject={runtimeHostId !== 'local'}
            showAddProject={runtimeHostId === 'local'}
          />
          {canAttach && (
            <button
              className="chat-attach-btn"
              title={t('chat.attach.addFile')}
              onClick={() =>
                void window.agentOs.app
                  .selectFile(
                    canAttachFiles
                      ? undefined
                      : { allowedExtensions: attachmentCapabilities?.allowedExtensions }
                  )
                  .then((path) => {
                    if (!path) return
                    if (
                      !attachmentTypeAllowed(
                        path,
                        canAttachImages,
                        canAttachFiles,
                        attachmentCapabilities?.allowedExtensions
                      )
                    ) {
                      useNotificationStore
                        .getState()
                        .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
                      return
                    }
                    if (!fitHeroAttachments([path]).length) return
                    setAttachments((current) =>
                      addDraftAttachment(current, {
                        id: path,
                        path,
                        displayName: basename(path)
                      })
                    )
                  })
              }
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M12.5 6.5L6.5 12.5A4 4 0 0 1 .914 6.914l6-6A2.5 2.5 0 0 1 10.5 4.5l-6 6A1 1 0 0 1 3.086 9.086L8.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button
            className="composer-send"
            onClick={handleSend}
            disabled={(mode === 'chat' && !input.trim()) || !engineId || loading}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path
                d="M5.5 1.5v8M2 5.5l3.5-4 3.5 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {mode === 'cli' ? t('chat.action.openTerminal') : t('chat.action.send')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 复制按钮 ─────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const { t } = useT()
  const handleCopy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button
      className={`msg-copy-btn${copied ? ' is-copied' : ''}`}
      onClick={handleCopy}
      title={copied ? t('chat.copy.copied') : t('common.action.copy')}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M1.5 6.5l3 3 6-6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect
            x="3.5"
            y="3.5"
            width="7"
            height="7"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M8.5 3.5V3A1.5 1.5 0 0 0 7 1.5H3A1.5 1.5 0 0 0 1.5 3v4A1.5 1.5 0 0 0 3 8.5h.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  )
}

// ─── 消息级标注（收藏 + 标签，SPEC-025） ───────────────────────────────────────

function messageRefOf(
  item: Extract<ChatItem, { kind: 'message' }>,
  view: WorkbenchSessionView
): AnnotationTargetRef | null {
  // 自建对话消息：用稳定 messageId（UUID）。
  if (item.messageId) {
    return { kind: 'message', source: 'managed', sessionId: view.id, messageId: item.messageId }
  }
  // CLI 历史消息：用 (toolId, nativeSessionId, seq)。
  if (typeof item.seq === 'number' && view.toolId && view.nativeSessionId) {
    return {
      kind: 'message',
      source: 'cli',
      toolId: view.toolId,
      nativeSessionId: view.nativeSessionId,
      seq: item.seq
    }
  }
  return null
}

function MessageAnno({
  item,
  view
}: {
  item: Extract<ChatItem, { kind: 'message' }>
  view: WorkbenchSessionView
}): React.JSX.Element | null {
  const ref = useMemo(() => messageRefOf(item, view), [item, view])
  const refKey = useMemo(() => (ref ? annotationTargetKey(ref) : null), [ref])
  const [editing, setEditing] = useState(false)
  const { t } = useT()
  const entries = useAnnotationsStore((s) => s.entries)
  const toggleFavorite = useAnnotationsStore((s) => s.toggleFavorite)
  const loadMany = useAnnotationsStore((s) => s.loadMany)
  // 用稳定字符串键做依赖，避免对象字面量每次渲染变更触发 fetch → setState → 重渲染 死循环。
  useEffect(() => {
    if (ref) void loadMany([ref])
  }, [refKey, loadMany])
  if (!ref) return null
  const anno = entries.get(annotationTargetKey(ref)) ?? { favorite: false, tags: [] }
  const meta = { label: messagePreview(item.text), toolId: view.toolId }
  return (
    <>
      <button
        type="button"
        className={`anno-star ${anno.favorite ? 'is-active' : ''}`}
        aria-label={anno.favorite ? t('chat.anno.unfavorite') : t('chat.anno.favorite')}
        onClick={() => void toggleFavorite(ref, !anno.favorite, meta)}
      >
        {anno.favorite ? '★' : '☆'}
      </button>
      <button
        type="button"
        className="anno-tag-btn"
        aria-label={t('chat.anno.editTags')}
        onClick={() => setEditing(true)}
      >
        #
      </button>
      {anno.tags.length > 0 ? (
        <span className="anno-tags anno-tags--inline">
          {anno.tags.slice(0, 4).map((tag) => (
            <button
              key={tag}
              type="button"
              className="anno-tag-chip"
              title={tag}
              onClick={() => setEditing(true)}
            >
              {tag}
            </button>
          ))}
          {anno.tags.length > 4 ? (
            <button
              type="button"
              className="anno-tag-chip"
              title={anno.tags.slice(4).join(' / ')}
              onClick={() => setEditing(true)}
            >
              +{anno.tags.length - 4}
            </button>
          ) : null}
        </span>
      ) : null}
      <TagEditor
        open={editing}
        targetRef={ref}
        meta={meta}
        title={t('chat.anno.editTags')}
        onClose={() => setEditing(false)}
      />
    </>
  )
}

// 消息文本预览：单行、截断，用作收藏页展示快照 label。
function messagePreview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// ─── 3 色点动画（等待响应） ────────────────────────────────────────────────────

function TypingIndicator(): React.JSX.Element {
  return (
    <div className="msg-typing">
      <span className="dot dot-1" />
      <span className="dot dot-2" />
      <span className="dot dot-3" />
    </div>
  )
}

// 自动折叠容器：open 只在「期望状态」变化时同步到内部 state，
// 平时保留用户的手动展开/折叠；delta re-render 不会反复重置 DOM，避免「一卡卡的」。
// 用于思考/过程块：运行中默认展开，完成（期望→false）时自动折叠，用户可再次手动展开。
function AutoDetails({
  open: desired,
  className,
  children
}: {
  open: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(desired)
  const prev = useRef(desired)
  useEffect(() => {
    if (desired !== prev.current) {
      setOpen(desired)
      prev.current = desired
    }
  }, [desired])
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      {children}
    </details>
  )
}

// ─── 工具调用块 ────────────────────────────────────────────────────────────────

function toolFile(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    for (const k of ['file_path', 'path', 'filePath', 'command', 'pattern', 'url']) {
      if (typeof o[k] === 'string') return o[k] as string
    }
  }
  return ''
}

function ToolBlock({
  item,
  active
}: {
  item: Extract<ChatItem, { kind: 'tool' }>
  active?: boolean
}): React.JSX.Element {
  const { t } = useT()
  const running = item.result === undefined && !item.isError
  const input = jsonText(item.input)
  const output = compactOutput(item.result)
  const file = toolFile(item.input)
  return (
    <AutoDetails
      className={`tool-block is-${running ? 'running' : item.isError ? 'error' : 'done'}`}
      open={Boolean(active)}
    >
      <summary className="tool-block__head">
        {running && <span className="agent-process__pulse" aria-hidden="true" />}
        <span className="tool-verb">{item.toolName}</span>
        {file && <span className="tool-file">{file}</span>}
        <span className="tool-detail">
          {item.isError
            ? t('chat.tool.error')
            : item.result !== undefined
              ? t('common.action.done')
              : t('chat.tool.running')}
        </span>
      </summary>
      {(input || output) && (
        <div className="tool-block__body">
          {input && (
            <>
              <div className="agent-process-step__label">Input</div>
              <pre>{input}</pre>
            </>
          )}
          {output && (
            <>
              <div className="agent-process-step__label">Output</div>
              <pre>{output}</pre>
            </>
          )}
        </div>
      )}
    </AutoDetails>
  )
}

function jsonText(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function ProcessStepRow({
  step,
  running
}: {
  step: ProcessStep
  running?: boolean
}): React.JSX.Element {
  const input = jsonText(step.input)
  const output = compactOutput(step.output)
  const hasBody = Boolean(step.detail || input || output)
  const summary = step.detail || (step.input ? toolSummary(step.input) : '')
  // error 步骤总展开；思考/工具步骤在 process 运行中默认展开（流式 detail/input 撑起高度），完成自动折叠。
  const stepOpen =
    step.kind === 'error' || Boolean(running && (step.kind === 'thinking' || step.kind === 'tool'))

  return (
    <AutoDetails
      className={`agent-process-step is-${step.kind} ${step.isError ? 'is-error' : ''}`}
      open={stepOpen}
    >
      <summary className="agent-process-step__head">
        <span className="agent-process-step__glyph" aria-hidden="true" />
        <span className="agent-process-step__title">{step.title}</span>
        {summary && <span className="agent-process-step__summary">{summary}</span>}
        {step.status && (
          <span className={`agent-process-step__status is-${step.status}`}>{step.status}</span>
        )}
      </summary>
      {hasBody && (
        <div className="agent-process-step__body">
          {step.kind === 'thinking' && step.detail && <pre>{step.detail}</pre>}
          {step.kind !== 'thinking' && step.detail && !input && !output && <pre>{step.detail}</pre>}
          {input && (
            <>
              <div className="agent-process-step__label">Input</div>
              <pre>{input}</pre>
            </>
          )}
          {output && (
            <>
              <div className="agent-process-step__label">Output</div>
              <pre>{output}</pre>
            </>
          )}
        </div>
      )}
    </AutoDetails>
  )
}

function ProcessBlock({
  item
}: {
  item: Extract<ChatItem, { kind: 'process' }>
}): React.JSX.Element {
  const { t } = useT()
  return (
    <AutoDetails className={`agent-process is-${item.status}`} open={item.status === 'running'}>
      <summary className="agent-process__head">
        {/* 折叠时显示 collapsed icon，展开时显示 expanded icon */}
        <svg
          className="agent-process__icon-collapsed"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5 3l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <svg
          className="agent-process__icon-expanded"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 5l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {item.status === 'running' && <span className="agent-process__pulse" aria-hidden="true" />}
        <span className="agent-process__title">{item.title}</span>
        <span className="agent-process__count">
          {t('chat.process.stepCount', { count: item.steps.length })}
        </span>
      </summary>
      <div className="agent-process__body">
        {item.steps.map((step) => (
          <ProcessStepRow key={step.id} step={step} running={item.status === 'running'} />
        ))}
      </div>
    </AutoDetails>
  )
}

// 思考块：进行中默认展开（让用户看到完整思考过程），完成后自动折叠；用户可再次手动展开。
function ThinkingBlock({
  item,
  active
}: {
  item: Extract<ChatItem, { kind: 'thinking' }>
  active?: boolean
}): React.JSX.Element {
  const { t } = useT()
  const preview = item.text.replace(/\s+/g, ' ').slice(0, 80)
  return (
    <AutoDetails open={Boolean(active)} className={`msg-thinking ${active ? 'is-active' : ''}`}>
      <summary className="msg-thinking__head">
        <span className="msg-thinking__label">{t('chat.process.thinkingTitle')}</span>
        <span className="msg-thinking__preview">{preview}</span>
        {active && <span className="agent-process__pulse" aria-hidden="true" />}
        <svg
          className="msg-thinking__chevron"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
        >
          <path
            d="M2 3.5l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="msg-thinking__body">{item.text}</div>
    </AutoDetails>
  )
}

// ─── 审批卡（原型未含，按 token 扩展） ────────────────────────────────────────

function PermissionBlock({
  item,
  sessionId,
  onResolved
}: {
  item: Extract<ChatItem, { kind: 'permission' }>
  sessionId: string
  onResolved(state: ChatTurnState): void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const { t } = useT()
  const respond = async (decision: PermissionDecision): Promise<void> => {
    setBusy(true)
    try {
      onResolved(await window.agentOs.chat.respondPermission(sessionId, item.requestId, decision))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      style={{
        margin: '4px 22px',
        maxWidth: 860,
        marginLeft: 'auto',
        marginRight: 'auto',
        width: '100%',
        border: '1px solid var(--border-medium)',
        borderRadius: 10,
        background: 'var(--bg-panel)',
        padding: 12
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
        {t('chat.permission.needConfirm', { toolName: item.toolName })}
      </div>
      <pre
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          background: 'var(--bg-surface)',
          borderRadius: 6,
          padding: '8px 10px',
          overflowX: 'auto',
          margin: '0 0 8px'
        }}
      >
        {JSON.stringify(item.input, null, 2)}
      </pre>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          disabled={busy}
          onClick={() => void respond('deny')}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 7,
            border: '1px solid var(--border-medium)',
            background: 'var(--bg-card)',
            fontSize: 12,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            font: 'inherit'
          }}
        >
          {t('chat.permission.deny')}
        </button>
        <button
          disabled={busy}
          onClick={() => void respond('always')}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 7,
            border: '1px solid var(--border-medium)',
            background: 'var(--bg-card)',
            fontSize: 12,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            font: 'inherit'
          }}
        >
          {t('chat.permission.alwaysAllow')}
        </button>
        <button
          disabled={busy}
          onClick={() => void respond('once')}
          style={{
            height: 28,
            padding: '0 14px',
            borderRadius: 7,
            border: 'none',
            background: 'var(--text-primary)',
            color: 'var(--bg-surface)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            font: 'inherit'
          }}
        >
          {busy ? t('chat.permission.processing') : t('chat.permission.allowOnce')}
        </button>
      </div>
    </div>
  )
}

function ChatItemView({
  item,
  view,
  displayName,
  active,
  isTail,
  onPermissionResolved
}: {
  item: ChatItem
  view: WorkbenchSessionView
  displayName: string
  /** 该块属于当前活跃 turn：turn 进行中保持展开，turn 彻底结束后才折叠。 */
  active?: boolean
  /** 该块是活跃 turn 正在产出的最后一块（用于头像旁三点）。 */
  isTail?: boolean
  onPermissionResolved?: (
    item: Extract<ChatItem, { kind: 'permission' }>,
    next: ChatTurnState
  ) => void
}): React.JSX.Element | null {
  if (item.kind === 'message') {
    if (item.role === 'system') {
      return (
        <div className="msg is-agent">
          <div className="msg-system-note">
            <Markdown content={item.text} />
          </div>
        </div>
      )
    }

    const isUser = item.role === 'user'
    return (
      <div className={`msg ${isUser ? 'is-user' : 'is-agent'}`}>
        {isUser ? (
          <>
            <div className="msg-bubble">
              <Markdown content={item.text} preserveSoftBreaks />
            </div>
            <div className="msg-actions">
              <CopyButton text={item.text} />
              <MessageAnno item={item} view={view} />
            </div>
          </>
        ) : (
          <>
            <div className="msg-agent-header">
              <ToolIcon toolId={view.toolId} size={DETAIL_AGENT_ICON_SIZE} brandColor />
              <span className="msg-agent-name">{displayName}</span>
              {isTail && (
                <span className="msg-agent-typing" aria-hidden="true">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                </span>
              )}
            </div>
            <div className="msg-body">
              <Markdown content={item.text} />
            </div>
            <div className="msg-actions">
              <CopyButton text={item.text} />
              <MessageAnno item={item} view={view} />
            </div>
          </>
        )}
      </div>
    )
  }

  if (item.kind === 'tool') {
    return (
      <div className="msg is-agent">
        <ToolBlock item={item} active={active} />
      </div>
    )
  }

  if (item.kind === 'process') {
    return (
      <div className="msg is-agent">
        <ProcessBlock item={item} />
      </div>
    )
  }

  if (item.kind === 'thinking') {
    return (
      <div className="msg is-agent">
        <ThinkingBlock item={item} active={active} />
      </div>
    )
  }

  if (item.kind === 'permission' && onPermissionResolved) {
    return (
      <PermissionBlock
        item={item}
        sessionId={view.id}
        onResolved={(next) => onPermissionResolved(item, next)}
      />
    )
  }

  return null
}

function ChatSurface({
  view,
  onOpenSession,
  highlight,
  onHighlightConsumed
}: {
  view: WorkbenchSessionView
  onOpenSession(view: WorkbenchSessionView): void
  highlight?: string
  onHighlightConsumed?: () => void
}): React.JSX.Element {
  const { t } = useT()
  const tools = useToolsStore((s) => s.results)
  const refreshSessions = useSessionsStore((s) => s.refresh)
  const consumePendingPrompt = useSessionsStore((s) => s.consumePendingPrompt)
  const pendingPrompt = useSessionsStore((s) => s.pendingPrompt[view.id])

  // SPEC-041：附件入口按 Agent 与当前模型的原生输入能力取交集。
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const runtimes = useToolsStore((s) => s.runtimes)
  const [selectedModelInfo, setSelectedModelInfo] = useState<ToolModelInfo>()
  const attachmentCapabilities = runtimes.find(
    (runtime) =>
      runtime.toolId === view.toolId &&
      (runtime.runtimeHostId ?? 'local') === (view.runtimeHostId ?? 'local')
  )?.capabilities.attachments
  // remote 节点会话 CLI 跑在远端、读不到本地暂存文件 → 隐藏附件入口（同 claude --file 既有约束）。
  const isRemoteSession = !!view.runtimeHostId && view.runtimeHostId !== 'local'
  const modelModalities = selectedModelInfo?.inputModalities
  const canAttachImages =
    attachmentCapabilities?.images === true &&
    (!modelModalities || modelModalities.includes('image'))
  const canAttachFiles =
    attachmentCapabilities?.files === true &&
    (!modelModalities || modelModalities.includes('file') || modelModalities.includes('pdf'))
  const canAttach = (canAttachImages || canAttachFiles) && !isRemoteSession
  const fitSurfaceAttachments = <T,>(candidates: T[]): T[] => {
    const { accepted, limited } = fitAttachmentLimit(
      attachedFiles.length,
      candidates,
      attachmentCapabilities?.maxFiles
    )
    if (limited) {
      useNotificationStore.getState().show({
        message: t('chat.attach.tooMany', {
          count: attachmentCapabilities?.maxFiles ?? 0
        }),
        tone: 'warning'
      })
    }
    return accepted
  }

  useEffect(() => {
    let cancelled = false
    const request = isRemoteSession
      ? window.agentOs.discovery.listModelsOn({
          toolId: view.toolId,
          hostId: view.runtimeHostId
        })
      : window.agentOs.discovery.listModels(view.toolId)
    void request
      .then((catalog) => {
        if (cancelled) return
        setSelectedModelInfo(
          catalog.models.find((model) => model.id === view.model) ??
            (!view.model ? catalog.models.find((model) => model.isDefault) : undefined)
        )
      })
      .catch(() => {
        if (!cancelled) setSelectedModelInfo(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [isRemoteSession, view.model, view.runtimeHostId, view.toolId])

  const [messages, setMessages] = useState<ManagedChatMessage[]>([])
  const [timeline, setTimeline] = useState<ManagedChatTimelineItem[]>([])
  const [legacyItems, setLegacyItems] = useState<ChatItem[]>([])
  const [queuedTurns, setQueuedTurns] = useState<ManagedQueuedTurn[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [state, setState] = useState<ChatTurnState | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const forceFollowRef = useRef(true)
  const [autoFollow, setAutoFollow] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')

  const displayName = tools.find((t) => t.toolId === view.toolId)?.displayName ?? view.toolId
  const color = toolColor(view.toolId)
  const draftKey = `agent-os.chat-draft.${view.id}`

  const items = useMemo(() => {
    const base =
      timeline.length > 0 ? timelineItems(messages, timeline, state?.status ?? 'idle') : legacyItems
    if (!state?.pendingPermission) return base
    const permission: ChatItem = {
      id: `permission-${state.pendingPermission.requestId}`,
      kind: 'permission',
      requestId: state.pendingPermission.requestId,
      toolName: state.pendingPermission.toolName,
      input: state.pendingPermission.input
    }
    return [
      ...base.filter(
        (item) => item.kind !== 'permission' || item.requestId !== permission.requestId
      ),
      permission
    ]
  }, [legacyItems, messages, state?.pendingPermission, state?.status, timeline])

  // 高亮当前搜索词：Ctrl+F 打开时用会话内输入，否则用全局搜索带入的词。
  const highlightQuery = findOpen ? findQuery : highlight
  const {
    count: findCount,
    index: findIndex,
    goTo: findGoTo
  } = useContentHighlight(
    messagesRef,
    highlightQuery,
    items.length,
    findOpen ? undefined : onHighlightConsumed
  )

  // Ctrl/Cmd+F 打开会话内搜索。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let cancelled = false
    forceFollowRef.current = true
    setAutoFollow(true)
    setMessages([])
    setTimeline([])
    setLegacyItems([])
    setQueuedTurns([])
    void window.agentOs.chat.state(view.id).then((next) => {
      if (!cancelled) setState(next)
    })
    void (async () => {
      try {
        const [managed, persistedTimeline, queued] = await Promise.all([
          window.agentOs.chat.history(view.id),
          window.agentOs.chat.timeline(view.id),
          window.agentOs.chat.listQueuedTurns(view.id)
        ])
        let loaded = managedItems(managed)
        if (managed.length === 0 && view.nativeSessionId) {
          const t = await window.agentOs.memory.getTranscript(
            `${view.toolId}:${view.nativeSessionId}`
          )
          if (t) loaded = transcriptItems(t.messages)
        }
        if (!cancelled) {
          setMessages(managed)
          setTimeline(persistedTimeline)
          setLegacyItems(loaded)
          setQueuedTurns(queued)
        }
      } catch {
        // 历史读取失败不阻断
      }
    })()
    return () => {
      cancelled = true
    }
  }, [view.id, view.nativeSessionId, view.toolId])

  useEffect(() => {
    try {
      setInput(window.localStorage.getItem(draftKey) ?? '')
    } catch {
      setInput('')
    }
  }, [draftKey])

  useEffect(() => {
    try {
      if (input.trim()) window.localStorage.setItem(draftKey, input)
      else window.localStorage.removeItem(draftKey)
    } catch {
      // 草稿缓存是体验增强，不阻断输入。
    }
  }, [draftKey, input])

  useEffect(
    () =>
      window.agentOs.events.onAgentEvent(({ sessionId, event, timelineItem }) => {
        if (sessionId !== view.id) return
        setLegacyItems((cur) => applyAgentEvent(cur, event, itemId()))
        if (timelineItem) setTimeline((cur) => upsertTimelineItem(cur, timelineItem))
        if (event.kind === 'permission-request') {
          void window.agentOs.chat.state(view.id).then(setState)
        }
        if (event.kind === 'turn-end' || (event.kind === 'error' && !event.retryable)) {
          // 立即将 UI 切回 idle，避免按钮卡在「中断」态
          setState((prev) => (prev ? { ...prev, status: 'idle', pendingPermission: null } : null))
          window.setTimeout(() => {
            // 保护：若本地已是 idle，不让后端仍在 running 的旧状态覆盖
            void window.agentOs.chat.state(view.id).then((next) => {
              setState((prev) =>
                prev?.status === 'idle' && next.status === 'running' ? prev : next
              )
            })
            void Promise.all([
              window.agentOs.chat.history(view.id),
              window.agentOs.chat.timeline(view.id),
              window.agentOs.chat.listQueuedTurns(view.id)
            ]).then(([nextMessages, nextTimeline, nextQueued]) => {
              setMessages(nextMessages)
              setTimeline(nextTimeline)
              setQueuedTurns(nextQueued)
              setLegacyItems(managedItems(nextMessages))
            })
            void refreshSessions()
          }, 100)
        }
      }),
    [refreshSessions, view.id]
  )

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const onScroll = (): void => {
      setAutoFollow(
        shouldAutoFollowChatScroll({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          forceFollow: false
        })
      )
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [view.id])

  useEffect(() => {
    if (!autoFollow && !forceFollowRef.current) return
    endRef.current?.scrollIntoView({ block: 'end' })
    forceFollowRef.current = false
    setAutoFollow(true)
  }, [autoFollow, items])

  const running = state?.status === 'running' || state?.status === 'awaiting-permission'

  // SPEC-038：把 File（粘贴/拖拽）物化到主进程暂存目录，追加到附件列表。
  const stageFile = async (file: File): Promise<void> => {
    try {
      if (
        !attachmentTypeAllowed(
          file.name,
          canAttachImages,
          canAttachFiles,
          attachmentCapabilities?.allowedExtensions
        )
      ) {
        useNotificationStore
          .getState()
          .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
        return
      }
      const staged = await window.agentOs.attachments.stage(
        view.id,
        file.name || 'pasted.png',
        new Uint8Array(await file.arrayBuffer())
      )
      setAttachedFiles((cur) =>
        addAttachment(cur, { path: staged.path, displayName: staged.displayName })
      )
    } catch {
      useNotificationStore.getState().show({ message: t('chat.attach.pasteFailed'), tone: 'error' })
    }
  }

  // 粘贴：任意 file item 即拦截（否则浏览器会把文件名当文本插入）。
  // 先试拿剪贴板「复制的文件」原路径（Finder/资源管理器，渲染层拿不到磁盘路径）→ 作为附件路径直传；
  // 拿不到（截图/图片内容）才回落到 stage 物化。
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items
    if (!items) return
    const itemArr = Array.from(items)
    if (!itemArr.some((it) => it.kind === 'file')) return // 纯文本，放行默认插入
    // 同步段取出 image File 对象（paste 事件后 clipboardData 失效）。
    const imageFiles = itemArr
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    e.preventDefault()
    if (!canAttach) {
      useNotificationStore
        .getState()
        .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
      return
    }
    void (async () => {
      // 优先：Finder/资源管理器复制的文件 → 原绝对路径（不拷贝，与 selectFile 一致）。
      const paths = await window.agentOs.attachments.readClipboardFiles()
      if (paths.length) {
        const supportedPaths = paths.filter((path) =>
          attachmentTypeAllowed(
            path,
            canAttachImages,
            canAttachFiles,
            attachmentCapabilities?.allowedExtensions
          )
        )
        if (supportedPaths.length !== paths.length) {
          useNotificationStore
            .getState()
            .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
        }
        for (const p of fitSurfaceAttachments(supportedPaths)) {
          setAttachedFiles((cur) => addAttachment(cur, { path: p, displayName: basename(p) }))
        }
        return
      }
      // 回落：截图/图片内容 → stage 物化。
      for (const file of fitSurfaceAttachments(imageFiles)) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          useNotificationStore
            .getState()
            .show({ message: t('chat.attach.tooLarge'), tone: 'warning' })
          continue
        }
        void stageFile(file)
      }
    })()
  }

  // 拖拽：任意文件；不支持时仍 preventDefault 以免浏览器把文件当新窗口打开。
  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    if (!canAttach) {
      useNotificationStore
        .getState()
        .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
      return
    }
    const droppedFiles = Array.from(files)
    const supportedFiles = droppedFiles.filter((file) =>
      attachmentTypeAllowed(
        file.name,
        canAttachImages,
        canAttachFiles,
        attachmentCapabilities?.allowedExtensions
      )
    )
    if (supportedFiles.length !== droppedFiles.length) {
      useNotificationStore
        .getState()
        .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
    }
    for (const file of fitSurfaceAttachments(supportedFiles)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        useNotificationStore
          .getState()
          .show({ message: t('chat.attach.tooLarge'), tone: 'warning' })
        continue
      }
      void stageFile(file)
    }
  }

  const sendText = async (raw: string, initialFiles?: string[]): Promise<void> => {
    const text = raw.trim()
    if (!text) return
    if (running) {
      await queueText(text)
      return
    }
    const now = new Date().toISOString()
    const optimisticId = `optimistic-${itemId()}`
    const legacyId = itemId()
    const attached = initialFiles?.length
      ? initialFiles.map((path) => ({ path, displayName: basename(path) }))
      : attachedFiles.length
        ? [...attachedFiles]
        : undefined
    const files = attached?.map((a) => a.path)
    forceFollowRef.current = true
    setAttachedFiles([])
    setMessages((cur) => [
      ...cur,
      {
        id: optimisticId,
        role: 'user',
        text: attached
          ? `${text}\n[${t('chat.attach.fileList', { files: attached.map((a) => a.displayName).join(', ') })}]`
          : text,
        status: 'completed',
        createdAt: now,
        updatedAt: now
      }
    ])
    setLegacyItems((cur) => appendUserMessage(cur, text, legacyId))
    setSending(true)
    try {
      const nextState = await window.agentOs.chat.sendTurn(view.id, text, files)
      setState(nextState)
      if (nextState.taskAutomation?.status === 'created') {
        useNotificationStore.getState().show({
          message: t('chat.taskAutomation.created', { title: nextState.taskAutomation.title }),
          tone: 'success'
        })
      } else if (nextState.taskAutomation?.status === 'failed') {
        useNotificationStore.getState().show({
          message: t('chat.taskAutomation.failed', { error: nextState.taskAutomation.error }),
          tone: 'error'
        })
      }
      await refreshSessions()
    } catch (error) {
      // 回滚乐观插入的 user 消息（messages + legacyItems），避免「从未真正发出的消息」
      // 残留成孤儿、被渲染到回答下方（修 Bug：输出期间/刚结束就再发一条被 turnInProgress 拒绝）。
      setMessages((cur) => cur.filter((message) => message.id !== optimisticId))
      setLegacyItems((cur) => cur.filter((item) => item.id !== legacyId))
      // 文本与附件回填到输入框，便于用户改后重发。
      setInput(text)
      if (attached) setAttachedFiles(attached)
      const message = error instanceof Error ? error.message : String(error)
      useNotificationStore.getState().show({ message, tone: 'error' })
    } finally {
      setSending(false)
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  const queueText = async (text: string): Promise<void> => {
    const attached = attachedFiles.length ? [...attachedFiles] : undefined
    const files = attached?.map((a) => a.path)
    setAttachedFiles([])
    setSending(true)
    try {
      const queued = await window.agentOs.chat.queueTurn(view.id, text, files)
      setQueuedTurns((cur) => [...cur.filter((turn) => turn.id !== queued.id), queued])
      setState(await window.agentOs.chat.state(view.id))
      await refreshSessions()
    } catch (error) {
      setInput(text)
      if (attached) setAttachedFiles(attached)
      const message = error instanceof Error ? error.message : String(error)
      useNotificationStore.getState().show({ message, tone: 'error' })
    } finally {
      setSending(false)
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  const steerText = async (text: string): Promise<void> => {
    const now = new Date().toISOString()
    const optimisticId = `optimistic-steer-${itemId()}`
    const legacyId = itemId()
    const attached = attachedFiles.length ? [...attachedFiles] : undefined
    const files = attached?.map((a) => a.path)
    setAttachedFiles([])
    forceFollowRef.current = true
    setMessages((cur) => [
      ...cur,
      {
        id: optimisticId,
        role: 'user',
        text: attached
          ? `${text}\n[${t('chat.attach.fileList', { files: attached.map((a) => a.displayName).join(', ') })}]`
          : text,
        status: 'completed',
        createdAt: now,
        updatedAt: now
      }
    ])
    setLegacyItems((cur) => appendUserMessage(cur, text, legacyId))
    setSending(true)
    try {
      setState(await window.agentOs.chat.steerTurn(view.id, text, files))
      await refreshSessions()
    } catch (error) {
      setMessages((cur) => cur.filter((message) => message.id !== optimisticId))
      setLegacyItems((cur) => cur.filter((item) => item.id !== legacyId))
      setInput(text)
      if (attached) setAttachedFiles(attached)
      useNotificationStore.getState().show({
        message: error instanceof Error ? error.message : String(error),
        tone: 'error'
      })
    } finally {
      setSending(false)
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  const send = (): void => {
    if (!input.trim()) return
    const text = input
    setInput('')
    if (running) void steerText(text)
    else void sendText(text)
  }

  const queueCurrent = (): void => {
    if (!input.trim()) return
    const text = input
    setInput('')
    void queueText(text)
  }

  // Hero 创建会话时暂存的首条消息：进入即自动发出。
  useEffect(() => {
    if (!pendingPrompt) return
    consumePendingPrompt(view.id)
    forceFollowRef.current = true
    void sendText(pendingPrompt.text, pendingPrompt.files)
  }, [pendingPrompt, view.id])

  const cancelQueuedTurn = (queuedTurnId: string): void => {
    void window.agentOs.chat.cancelQueuedTurn(view.id, queuedTurnId).then((removed) => {
      if (!removed) return
      setQueuedTurns((cur) => cur.filter((turn) => turn.id !== queuedTurnId))
      void window.agentOs.chat.state(view.id).then(setState)
    })
  }

  const interrupt = (): void => {
    void window.agentOs.chat
      .interrupt(view.id)
      .then(() => window.agentOs.chat.state(view.id).then(setState))
  }

  const jumpToLatest = (): void => {
    forceFollowRef.current = true
    endRef.current?.scrollIntoView({ block: 'end' })
    setAutoFollow(true)
  }

  const statusText = processStatusText(timeline, state?.status ?? 'idle')
  const inputDisabled = state?.status === 'awaiting-permission'

  return (
    <div className="chat-view" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
      <div className="chat-header">
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: sessionStatusColor(view.status),
            flexShrink: 0
          }}
        />
        <div className="chat-header__name">{sessionDisplayTitle(view)}</div>
        <div className="chat-header__status">
          <OriginBadge hostId={view.runtimeHostId} />
          <RelayTrigger
            sourceSessionId={view.id}
            sourceSurface={view.surface === 'terminal' ? 'cli' : 'chat'}
            sourceToolId={view.toolId}
            sourceDisplayName={displayName}
            sourceRuntimeHostId={view.runtimeHostId}
            onRelayed={onOpenSession}
          />
          {view.relaySource && (
            <span className="relay-inline-chip">接力自 {view.relaySource.toolId}</span>
          )}
          {view.relayTarget && (
            <span className="relay-inline-chip">已接力给 {view.relayTarget.toolId}</span>
          )}
          <span>{basename(view.workspacePath)}/</span>
          {view.nativeSessionId && (
            <span title={view.nativeSessionId}>native {view.nativeSessionId.slice(0, 8)}</span>
          )}
          <span>
            {statusText}
            {state?.status === 'running' && (
              <span className="msg-agent-typing" aria-hidden="true">
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <span className="thinking-dot" />
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="chat-messages" ref={messagesRef}>
        {findOpen && (
          <InPageSearch
            query={findQuery}
            onQueryChange={setFindQuery}
            count={findCount}
            index={findIndex}
            onGoTo={findGoTo}
            onClose={() => {
              setFindOpen(false)
              setFindQuery('')
            }}
          />
        )}
        {(() => {
          const turnRunning =
            state?.status === 'running' || state?.status === 'awaiting-permission' || sending
          let lastAgentIdx = -1
          let lastUserIdx = -1
          for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i]
            if (lastAgentIdx === -1 && (it.kind !== 'message' || it.role !== 'user'))
              lastAgentIdx = i
            if (it.kind === 'message' && it.role === 'user') {
              lastUserIdx = i
              break
            }
          }
          return items.map((item, index) => (
            <ChatItemView
              key={item.id}
              item={item}
              view={view}
              displayName={displayName}
              active={turnRunning && index > lastUserIdx}
              isTail={turnRunning && index === lastAgentIdx}
              onPermissionResolved={(permission, next) => {
                setState(next)
                setLegacyItems((cur) =>
                  cur.filter((c) => c.kind !== 'permission' || c.requestId !== permission.requestId)
                )
                void window.agentOs.chat.timeline(view.id).then(setTimeline)
              }}
            />
          ))
        })()}
        {(state?.status === 'running' || sending) &&
          timeline.length === 0 &&
          !items.some((i) => i.kind === 'message' && i.role !== 'user') && (
            <div className="msg is-agent">
              <div className="msg-agent-header">
                <ToolIcon toolId={view.toolId} size={DETAIL_AGENT_ICON_SIZE} brandColor />
                <span className="msg-agent-name">{displayName}</span>
              </div>
              <TypingIndicator />
            </div>
          )}
        <div ref={endRef} />
        {!autoFollow && (
          <button type="button" className="chat-jump-latest" onClick={jumpToLatest}>
            {t('chat.scroll.jumpLatest')}
          </button>
        )}
      </div>

      <div className="chat-input-bar">
        <div className="chat-input-inner">
          {queuedTurns.length > 0 && (
            <div className="chat-queued-list">
              <div className="chat-queued-list__head">
                {t('chat.queue.title', { count: queuedTurns.length })}
              </div>
              {queuedTurns.map((turn, index) => (
                <div key={turn.id} className="chat-queued-item">
                  <div className="chat-queued-item__order">{index + 1}</div>
                  <div className="chat-queued-item__body">
                    <div className="chat-queued-item__text">{turn.text}</div>
                    {turn.files.length > 0 && (
                      <div className="chat-queued-item__files">
                        {t('chat.queue.files', { files: turn.files.map(basename).join(', ') })}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="chat-queued-item__cancel"
                    onClick={() => cancelQueuedTurn(turn.id)}
                    title={t('chat.queue.cancel')}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachedFiles.length > 0 && (
            <div className="chat-attached-files">
              {attachedFiles.map((f) => (
                <AttachmentPreviewItem
                  key={f.path}
                  attachment={f}
                  onRemove={() =>
                    setAttachedFiles((cur) => cur.filter((candidate) => candidate.path !== f.path))
                  }
                />
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="chat-input-text"
            placeholder={
              inputDisabled ? t('chat.input.placeholderAwaiting') : t('chat.input.placeholder')
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && running) {
                e.preventDefault()
                interrupt()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            disabled={inputDisabled}
            style={{
              width: '100%',
              border: 'none',
              outline: 'none',
              resize: 'none',
              background: 'transparent',
              fontFamily: 'inherit',
              color: 'var(--text-primary)'
            }}
          />
          <div className="chat-input-footer">
            {inputDisabled && (
              <span className="chat-input-hint">{t('chat.input.awaitingHint')}</span>
            )}
            {canAttach && (
              <button
                className="chat-attach-btn"
                title={t('chat.attach.addFile')}
                onClick={() =>
                  void window.agentOs.app
                    .selectFile(
                      canAttachFiles
                        ? undefined
                        : { allowedExtensions: attachmentCapabilities?.allowedExtensions }
                    )
                    .then((path) => {
                      if (
                        path &&
                        fitSurfaceAttachments([path]).length > 0 &&
                        attachmentTypeAllowed(
                          path,
                          canAttachImages,
                          canAttachFiles,
                          attachmentCapabilities?.allowedExtensions
                        )
                      )
                        setAttachedFiles((cur) =>
                          addAttachment(cur, { path, displayName: basename(path) })
                        )
                      else if (path)
                        useNotificationStore
                          .getState()
                          .show({ message: t('chat.attach.unsupported'), tone: 'warning' })
                    })
                }
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M12.5 6.5L6.5 12.5A4 4 0 0 1 .914 6.914l6-6A2.5 2.5 0 0 1 10.5 4.5l-6 6A1 1 0 0 1 3.086 9.086L8.5 3.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
            <div style={{ flex: 1 }} />
            <ToolSelector
              value={view.toolId}
              onChange={() => {}}
              tools={[{ key: view.toolId, label: displayName, sub: '', color }]}
            />
            {state?.status === 'running' ? (
              <>
                <button
                  onClick={interrupt}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '0 10px',
                    height: 28,
                    borderRadius: 7,
                    background: 'var(--bg-active)',
                    border: 'none',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    flexShrink: 0
                  }}
                >
                  {t('chat.action.interrupt')} Esc
                </button>
                <button
                  onClick={queueCurrent}
                  disabled={!input.trim() || sending}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 10px',
                    height: 28,
                    borderRadius: 7,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-medium)',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    flexShrink: 0,
                    opacity: !input.trim() || sending ? 0.5 : 1
                  }}
                >
                  {t('chat.action.queue')}
                </button>
                <button
                  onClick={send}
                  disabled={!input.trim() || sending}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '0 12px',
                    height: 28,
                    borderRadius: 7,
                    background: 'var(--text-primary)',
                    border: 'none',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--bg-surface)',
                    cursor: 'pointer',
                    flexShrink: 0,
                    opacity: !input.trim() || sending ? 0.5 : 1
                  }}
                >
                  {t('chat.action.steer')}
                </button>
              </>
            ) : (
              <button
                onClick={send}
                disabled={!input.trim() || sending}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '0 12px',
                  height: 28,
                  borderRadius: 7,
                  background: 'var(--text-primary)',
                  border: 'none',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--bg-surface)',
                  cursor: 'pointer',
                  flexShrink: 0,
                  boxShadow: '0 1px 3px rgba(24,24,27,.18)',
                  opacity: !input.trim() || sending ? 0.5 : 1
                }}
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path
                    d="M5.5 1.5v8M2 5.5l3.5-4 3.5 4"
                    stroke="white"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t('chat.action.send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 终端历史（会话关闭后展示） ───────────────────────────────────────────────

function TerminalHistory({
  view,
  onReopen,
  highlight,
  onHighlightConsumed
}: {
  view: WorkbenchSessionView
  onReopen: () => Promise<void>
  highlight?: string
  onHighlightConsumed?: () => void
}): React.JSX.Element {
  const tools = useToolsStore((s) => s.results)
  const { t } = useT()
  const [meta, setMeta] = useState<MemoryTranscriptMeta | null>(null)
  const [messages, setMessages] = useState<NormalizedMessage[]>([])
  const [hasMoreBefore, setHasMoreBefore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // 从全局搜索跳转时，预填会话内搜索框：既过滤到命中消息，又复用高亮。
  const [histSearch, setHistSearch] = useState(highlight ?? '')
  const [loading, setLoading] = useState(true)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const displayName = tools.find((t) => t.toolId === view.toolId)?.displayName ?? view.toolId

  // 已打开的历史标签再次被搜索跳转命中（不重新挂载）时，同步搜索词。
  useEffect(() => {
    if (highlight) setHistSearch(highlight)
  }, [highlight])

  useEffect(() => {
    if (!view.nativeSessionId) {
      setLoading(false)
      return
    }
    setLoading(true)
    void window.agentOs.memory
      .getTranscriptPage({
        sessionId: `${view.toolId}:${view.nativeSessionId}`,
        direction: 'latest',
        limit: 160
      })
      .then((page) => {
        setMeta(page?.meta ?? null)
        setMessages(page?.messages ?? [])
        setHasMoreBefore(page?.hasMoreBefore ?? false)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [view.nativeSessionId, view.toolId])

  // 会话内搜索：非空 query 时走全量会话内检索（覆盖整段而非已加载页），250ms 防抖。
  const [searchHits, setSearchHits] = useState<NormalizedMessage[] | null>(null)
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    const q = histSearch.trim()
    if (!q || !view.nativeSessionId) {
      setSearchHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    let alive = true
    const timer = setTimeout(() => {
      void window.agentOs.memory
        .searchInSession({
          sessionId: `${view.toolId}:${view.nativeSessionId}`,
          query: q,
          limit: 300
        })
        .then((hits) => {
          if (alive) setSearchHits(hits)
        })
        .catch(() => {
          if (alive) setSearchHits([])
        })
        .finally(() => {
          if (alive) setSearching(false)
        })
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [histSearch, view.nativeSessionId, view.toolId])

  const query = histSearch.trim()
  const historyItems = transcriptHistoryItems(query ? (searchHits ?? []) : messages)

  // 高亮当前搜索词（含全局搜索带入的词）并滚到首个匹配。
  useContentHighlight(
    messagesRef,
    query,
    historyItems.length,
    highlight ? onHighlightConsumed : undefined
  )
  const loadBefore = async (): Promise<void> => {
    if (!view.nativeSessionId || !hasMoreBefore || loadingMore) return
    const cursor = messages[0]?.seq
    if (cursor === undefined) return
    setLoadingMore(true)
    try {
      const page = await window.agentOs.memory.getTranscriptPage({
        sessionId: `${view.toolId}:${view.nativeSessionId}`,
        cursor,
        direction: 'before',
        limit: 160
      })
      if (page) {
        const seen = new Set(messages.map((message) => message.seq))
        setMessages([...page.messages.filter((message) => !seen.has(message.seq)), ...messages])
        setMeta(page.meta)
        setHasMoreBefore(page.hasMoreBefore)
      }
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="cli-history-surface">
      <div className="cli-history-header">
        <div className="cli-history-header__left">
          <ToolIcon toolId={view.toolId} size={DETAIL_HEADER_TOOL_ICON_SIZE} brandColor />
          <span className="cli-history-header__title">
            {sessionDisplayTitle(view, meta?.title)}
          </span>
          <span className="cli-history-header__badge">{t('chat.history.closed')}</span>
        </div>
        <div className="cli-history-header__right">
          <div className="cli-history-search">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M8 8l2.5 2.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
            <input
              type="text"
              className="cli-history-search__input"
              placeholder={t('chat.history.searchPlaceholder')}
              value={histSearch}
              onChange={(e) => setHistSearch(e.target.value)}
            />
          </div>
          <button className="cli-history-reopen-btn" onClick={() => void onReopen()}>
            {t('chat.history.reopen')}
          </button>
        </div>
      </div>

      <div className="chat-messages cli-history-messages" ref={messagesRef}>
        {!query && hasMoreBefore && (
          <button
            className="record-load-more"
            disabled={loadingMore}
            onClick={() => void loadBefore()}
          >
            {loadingMore ? t('common.state.loading') : t('chat.history.loadEarlier')}
          </button>
        )}
        {loading && <div className="cli-history-empty">{t('chat.history.loadingRecords')}</div>}
        {!loading && historyItems.length === 0 && (
          <div
            className="cli-history-empty"
            style={{ whiteSpace: view.outputTail ? 'pre-wrap' : undefined }}
          >
            {query
              ? searching
                ? t('chat.history.searching')
                : t('chat.history.noMatch', { query: histSearch })
              : view.outputTail || t('chat.history.empty')}
          </div>
        )}
        {historyItems.map((item) => (
          <ChatItemView key={item.id} item={item} view={view} displayName={displayName} />
        ))}
      </div>
    </div>
  )
}

// ─── 终端详情（原型 terminal-view 外壳 + 真实 xterm） ─────────────────────────

function TerminalSurface({
  view,
  onOpenSession,
  highlight,
  onHighlightConsumed
}: {
  view: WorkbenchSessionView
  onOpenSession(view: WorkbenchSessionView): void
  highlight?: string
  onHighlightConsumed?: () => void
}): React.JSX.Element {
  const reopen = useSessionsStore((s) => s.reopen)
  const select = useSessionsStore((s) => s.select)
  const removeSession = useSessionsStore((s) => s.remove)
  const tools = useToolsStore((s) => s.results)
  const { t } = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const ptyId = view.terminalSessionId
  const displayName = tools.find((tool) => tool.toolId === view.toolId)?.displayName ?? view.toolId

  useEffect(() => {
    const container = containerRef.current
    if (!container || !ptyId) return
    attachTerminalSession(ptyId, container)
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => fitTerminalSession(ptyId))
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      detachTerminalSession(ptyId)
    }
  }, [ptyId])

  const handleReopen = async (): Promise<void> => {
    const created = await reopen(view.id)
    if (created) select(created.id)
  }

  if (!ptyId) {
    return (
      <div className="terminal-view">
        <div className="terminal-header">
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: sessionStatusColor(view.status),
              flexShrink: 0
            }}
          />
          <div className="terminal-header__path">{view.workspacePath || '~'}</div>
          <div className="terminal-header__relay">
            <RelayTrigger
              sourceSessionId={view.id}
              sourceSurface={view.surface === 'terminal' ? 'cli' : 'chat'}
              sourceToolId={view.toolId}
              sourceDisplayName={displayName}
              sourceRuntimeHostId={view.runtimeHostId}
              onRelayed={onOpenSession}
            />
          </div>
          {view.relaySource && (
            <span className="relay-inline-chip">接力自 {view.relaySource.toolId}</span>
          )}
          {view.relayTarget && (
            <span className="relay-inline-chip">已接力给 {view.relayTarget.toolId}</span>
          )}
          <button
            className="terminal-header__disc"
            title={t('chat.terminal.deleteSession')}
            onClick={() => void removeSession(view.id)}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path
                d="M2 2l9 9M11 2l-9 9"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <TerminalHistory
          view={view}
          onReopen={handleReopen}
          highlight={highlight}
          onHighlightConsumed={onHighlightConsumed}
        />
      </div>
    )
  }

  return (
    <div className="terminal-view">
      <div className="terminal-header">
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: sessionStatusColor(view.status),
            flexShrink: 0
          }}
        />
        <div className="terminal-header__path">{view.workspacePath || '~'}</div>
        <div className="terminal-header__relay">
          <RelayTrigger
            sourceSessionId={view.id}
            sourceSurface={view.surface === 'terminal' ? 'cli' : 'chat'}
            sourceToolId={view.toolId}
            sourceDisplayName={displayName}
            sourceRuntimeHostId={view.runtimeHostId}
            onRelayed={onOpenSession}
          />
        </div>
        {view.relaySource && (
          <span className="relay-inline-chip">接力自 {view.relaySource.toolId}</span>
        )}
        {view.relayTarget && (
          <span className="relay-inline-chip">已接力给 {view.relayTarget.toolId}</span>
        )}
        <button
          className="terminal-header__disc"
          title={t('chat.terminal.closeTerminal')}
          onClick={() => void removeSession(view.id)}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path
              d="M2 2l9 9M11 2l-9 9"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="terminal-body" style={{ padding: 0 }} ref={containerRef} />
    </div>
  )
}

// ─── 主入口：终端会话走原生 PTY，会话走结构化对话 ─────────────────────────────

export function ChatContent({
  onOpenSession,
  highlight,
  onHighlightConsumed
}: {
  onOpenSession(view: WorkbenchSessionView): void
  highlight?: string
  onHighlightConsumed?: () => void
}): React.JSX.Element {
  const views = useSessionsStore((s) => s.views)
  const selectedId = useSessionsStore((s) => s.selectedId)
  const view = views.find((v) => v.id === selectedId) ?? null

  if (!view) return <ChatHero onOpenSession={onOpenSession} />
  if (view.surface === 'terminal') {
    return (
      <TerminalSurface
        key={view.id}
        view={view}
        onOpenSession={onOpenSession}
        highlight={highlight}
        onHighlightConsumed={onHighlightConsumed}
      />
    )
  }
  return (
    <ChatSurface
      key={view.id}
      view={view}
      onOpenSession={onOpenSession}
      highlight={highlight}
      onHighlightConsumed={onHighlightConsumed}
    />
  )
}
