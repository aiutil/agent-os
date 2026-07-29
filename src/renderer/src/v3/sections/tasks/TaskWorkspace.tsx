import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AgentTask,
  CreateTaskInput,
  ManagedChatMessage,
  ManagedChatTimelineItem,
  TaskBoardStatus,
  TaskRun,
  TaskSchedule,
  UpdateTaskPatch
} from '@shared/types'
import { taskDeliveriesForRun, taskMessagesForRun, taskTimelineForRun } from '@shared/task-detail'
import { presentTaskStatus } from '@shared/task-presentation'
import { useNotificationStore } from '../../../stores/notificationStore'
import { useTasksStore } from '../../../stores/tasksStore'
import { useToolsStore } from '../../../stores/toolsStore'
import { Markdown } from '../../../lib/markdown/Markdown'

type TaskSection = 'board' | 'schedule'

const ACTIVE = new Set(['queued', 'running', 'needs_attention'])
const EMPTY_TASK_RUNS: TaskRun[] = []

function notifyError(error: unknown): void {
  useNotificationStore.getState().show({
    message: error instanceof Error ? error.message : String(error),
    tone: 'error'
  })
}

function hostLabel(hostId?: string): string {
  return !hostId || hostId === 'local' ? '本机' : hostId
}

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function runStatusLabel(status: TaskRun['status']): string {
  const labels: Record<TaskRun['status'], string> = {
    queued: '排队中',
    running: '执行中',
    needs_attention: '需要处理',
    succeeded: '执行成功',
    failed: '执行失败',
    interrupted: '已中断',
    skipped: '已跳过'
  }
  return labels[status]
}

function timelineTitle(item: ManagedChatTimelineItem): string {
  if (item.type === 'thinking') return 'Agent 思考'
  if (item.type === 'tool_use') return item.tool ? `调用工具 · ${item.tool}` : '调用工具'
  if (item.type === 'tool_result') return item.tool ? `工具结果 · ${item.tool}` : '工具结果'
  if (item.type === 'permission') return '权限请求'
  if (item.type === 'error') return '执行错误'
  return 'Agent 输出'
}

function detailPayload(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function TaskDetailModal({
  task,
  onClose,
  onOpenSession
}: {
  task: AgentTask
  onClose(): void
  onOpenSession(id: string): void
}): React.JSX.Element {
  const runs = useTasksStore((state) => state.runsByTask[task.id] ?? EMPTY_TASK_RUNS)
  const loadRuns = useTasksStore((state) => state.loadRuns)
  const update = useTasksStore((state) => state.update)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [tab, setTab] = useState<'process' | 'delivery'>('process')
  const [runsLoading, setRunsLoading] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ManagedChatMessage[]>([])
  const [timeline, setTimeline] = useState<ManagedChatTimelineItem[]>([])
  const sessionRequestRef = useRef(0)

  useEffect(() => {
    setRunsLoading(true)
    void loadRuns(task.id).finally(() => setRunsLoading(false))
  }, [loadRuns, task.id])

  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunId(null)
      return
    }
    if (!selectedRunId || !runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(runs[0].id)
    }
  }, [runs, selectedRunId])

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null
  const sessionId = selectedRun ? selectedRun.sessionId : task.latestSessionId

  const refreshSession = useCallback(
    async (silent = false): Promise<void> => {
      const requestId = ++sessionRequestRef.current
      if (!sessionId) {
        setMessages([])
        setTimeline([])
        setSessionError(null)
        setSessionLoading(false)
        return
      }
      if (!silent) setSessionLoading(true)
      const [historyResult, timelineResult] = await Promise.allSettled([
        window.agentOs.chat.history(sessionId),
        window.agentOs.chat.timeline(sessionId)
      ])
      if (requestId !== sessionRequestRef.current) return
      if (historyResult.status === 'fulfilled') setMessages(historyResult.value)
      if (timelineResult.status === 'fulfilled') setTimeline(timelineResult.value)
      if (historyResult.status === 'rejected' && timelineResult.status === 'rejected') {
        const reason =
          historyResult.reason instanceof Error
            ? historyResult.reason.message
            : String(historyResult.reason)
        setSessionError(reason || '读取会话过程失败')
      } else {
        setSessionError(null)
      }
      setSessionLoading(false)
    },
    [sessionId]
  )

  useEffect(() => {
    void refreshSession()
  }, [refreshSession, selectedRun?.status])

  useEffect(() => {
    if (!selectedRun || !ACTIVE.has(selectedRun.status)) return
    const timer = window.setInterval(() => void refreshSession(true), 2_000)
    return () => window.clearInterval(timer)
  }, [refreshSession, selectedRun])

  const scopedTimeline = useMemo(
    () => taskTimelineForRun(selectedRun, timeline),
    [selectedRun, timeline]
  )
  const scopedMessages = useMemo(
    () => taskMessagesForRun(selectedRun, messages),
    [messages, selectedRun]
  )
  const deliveries = useMemo(
    () => taskDeliveriesForRun(selectedRun, messages, timeline),
    [messages, selectedRun, timeline]
  )
  const fallbackProcess = scopedTimeline.length === 0 ? scopedMessages : []
  const statusPresentation = presentTaskStatus(task)

  const confirmTask = async (): Promise<void> => {
    setConfirming(true)
    try {
      await update(task.id, { boardStatus: 'done' })
    } catch (error) {
      notifyError(error)
    } finally {
      setConfirming(false)
    }
  }

  return createPortal(
    <div
      className="task-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="task-modal task-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`任务详情：${task.title}`}
      >
        <header>
          <div>
            <span>TASK DETAIL</span>
            <h2>{task.title}</h2>
          </div>
          <div className="task-detail__header-actions">
            <b className={`is-${statusPresentation.state}`} role="status" aria-live="polite">
              {statusPresentation.label}
            </b>
            <button onClick={onClose} aria-label="关闭任务详情">
              ×
            </button>
          </div>
        </header>

        <div className="task-detail__summary">
          <div>
            <span>Engineer</span>
            <strong>
              {task.assignee.toolId}
              {task.assignee.model ? ` · ${task.assignee.model}` : ''}
            </strong>
          </div>
          <div>
            <span>目标主机</span>
            <strong>{hostLabel(task.runtimeHostId)}</strong>
          </div>
          <div>
            <span>权限 / 会话</span>
            <strong>
              {task.permissionPreset} · {task.sessionPolicy === 'new' ? '每次新会话' : '延续上次'}
            </strong>
          </div>
          <div>
            <span>最近更新</span>
            <strong>{formatTime(task.updatedAt)}</strong>
          </div>
          <div className="task-detail__workspace">
            <span>工作目录</span>
            <strong>{task.workspacePath}</strong>
          </div>
          <div className="task-detail__prompt">
            <span>任务说明</span>
            <p>{task.prompt}</p>
          </div>
        </div>

        <div className="task-detail__body">
          <aside className="task-detail__runs">
            <div className="task-detail__section-head">
              <div>
                <span>RUN HISTORY</span>
                <h3>运行记录</h3>
              </div>
              <b>{runs.length}</b>
            </div>
            {runsLoading && runs.length === 0 && (
              <p className="task-detail__empty">正在读取运行记录…</p>
            )}
            {!runsLoading && runs.length === 0 && <p className="task-detail__empty">尚未执行</p>}
            {runs.map((run, index) => (
              <button
                key={run.id}
                className={run.id === selectedRunId ? 'is-active' : ''}
                onClick={() => setSelectedRunId(run.id)}
              >
                <span>
                  #{runs.length - index} · {run.trigger === 'schedule' ? '定时触发' : '手动触发'}
                </span>
                <strong>{runStatusLabel(run.status)}</strong>
                <em>{formatTime(run.startedAt ?? run.scheduledFor ?? run.finishedAt)}</em>
              </button>
            ))}
          </aside>

          <section className="task-detail__content">
            <div className="task-detail__tabs" role="tablist">
              <button
                className={tab === 'process' ? 'is-active' : ''}
                onClick={() => setTab('process')}
                role="tab"
                aria-selected={tab === 'process'}
              >
                执行过程 <span>{scopedTimeline.length || fallbackProcess.length}</span>
              </button>
              <button
                className={tab === 'delivery' ? 'is-active' : ''}
                onClick={() => setTab('delivery')}
                role="tab"
                aria-selected={tab === 'delivery'}
              >
                交付物 <span>{deliveries.length}</span>
              </button>
              <button
                className="task-detail__refresh"
                onClick={() => void refreshSession()}
                disabled={!sessionId || sessionLoading}
              >
                {sessionLoading ? '读取中…' : '刷新'}
              </button>
            </div>

            {sessionError && (
              <div className="task-detail__error">会话过程读取失败：{sessionError}</div>
            )}

            {tab === 'process' && (
              <div className="task-detail__process" role="tabpanel">
                {selectedRun && (
                  <div className="task-process-item is-lifecycle">
                    <i />
                    <div>
                      <header>
                        <strong>TaskRun · {runStatusLabel(selectedRun.status)}</strong>
                        <time>{formatTime(selectedRun.startedAt ?? selectedRun.scheduledFor)}</time>
                      </header>
                      <p>
                        {selectedRun.trigger === 'schedule' ? '由定时计划触发' : '由用户手动触发'}
                        {selectedRun.finishedAt
                          ? ` · ${formatTime(selectedRun.finishedAt)} 结束`
                          : ''}
                      </p>
                      {selectedRun.error && <pre>{selectedRun.error}</pre>}
                    </div>
                  </div>
                )}
                {scopedTimeline.map((item) => {
                  const body = [
                    item.content,
                    item.input !== undefined ? `Input\n${detailPayload(item.input)}` : '',
                    item.output ? `Output\n${item.output}` : ''
                  ]
                    .filter(Boolean)
                    .join('\n\n')
                  return (
                    <div
                      className={`task-process-item is-${item.type}${item.isError ? ' has-error' : ''}`}
                      key={item.id}
                    >
                      <i />
                      <div>
                        <header>
                          <strong>{timelineTitle(item)}</strong>
                          <time>{formatTime(item.createdAt)}</time>
                        </header>
                        {item.type === 'permission' && item.status && (
                          <p>处理状态：{item.status}</p>
                        )}
                        {body && <pre>{body}</pre>}
                      </div>
                    </div>
                  )
                })}
                {fallbackProcess.map((message) => (
                  <div className={`task-process-item is-${message.role}`} key={message.id}>
                    <i />
                    <div>
                      <header>
                        <strong>{message.role === 'assistant' ? 'Agent 输出' : '任务输入'}</strong>
                        <time>{formatTime(message.createdAt)}</time>
                      </header>
                      <pre>{message.text}</pre>
                    </div>
                  </div>
                ))}
                {!sessionLoading &&
                  !selectedRun &&
                  scopedTimeline.length === 0 &&
                  fallbackProcess.length === 0 && (
                    <div className="task-detail__empty-state">
                      <h3>尚无执行过程</h3>
                      <p>运行任务后，这里会显示 Agent 的思考、工具调用、权限处理和输出。</p>
                    </div>
                  )}
                {!sessionLoading &&
                  selectedRun &&
                  scopedTimeline.length === 0 &&
                  fallbackProcess.length === 0 && (
                    <div className="task-detail__empty-state">
                      <h3>本次运行没有会话过程</h3>
                      <p>
                        {selectedRun.sessionId
                          ? '会话尚未产生可展示内容，或目标节点暂时离线。'
                          : '本次运行在创建会话前结束。'}
                      </p>
                    </div>
                  )}
              </div>
            )}

            {tab === 'delivery' && (
              <div className="task-detail__deliveries" role="tabpanel">
                {deliveries.map((delivery) => (
                  <article key={delivery.id}>
                    <header>
                      <div>
                        <span>AGENT DELIVERY</span>
                        <strong>{delivery.status === 'streaming' ? '生成中' : '最终交付'}</strong>
                      </div>
                      <time>{formatTime(delivery.createdAt)}</time>
                    </header>
                    <div className="task-detail__markdown">
                      <Markdown content={delivery.text} />
                    </div>
                  </article>
                ))}
                {!sessionLoading && deliveries.length === 0 && (
                  <div className="task-detail__empty-state">
                    <h3>暂无交付物</h3>
                    <p>
                      {selectedRun?.status === 'running'
                        ? 'Agent 仍在执行，最终回复产生后会显示在这里。'
                        : '本次运行没有记录到 Agent 最终回复。'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <footer>
          <button onClick={onClose}>关闭</button>
          <button
            className={task.boardStatus === 'review' ? undefined : 'is-primary'}
            disabled={!sessionId}
            onClick={() => {
              if (!sessionId) return
              onOpenSession(sessionId)
              onClose()
            }}
          >
            打开会话
          </button>
          {task.boardStatus === 'review' && (
            <button className="is-primary" disabled={confirming} onClick={() => void confirmTask()}>
              {confirming ? '确认中…' : '确认完成'}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body
  )
}

export function TasksSecPanel({
  section,
  onSection,
  onNew
}: {
  section: TaskSection
  onSection(section: TaskSection): void
  onNew(): void
}): React.JSX.Element {
  const tasks = useTasksStore((state) => state.tasks)
  const loading = useTasksStore((state) => state.loading)
  const error = useTasksStore((state) => state.error)
  const active = tasks.filter((task) => ACTIVE.has(task.executionStatus)).length
  const review = tasks.filter((task) => task.boardStatus === 'review').length
  const scheduled = tasks.filter((task) => task.schedule?.enabled).length

  return (
    <div className="task-panel">
      <div className="task-panel__head">
        <div>
          <div className="task-panel__eyebrow">TASK CORE</div>
          <h2>{section === 'board' ? '任务看板' : '定时任务'}</h2>
        </div>
        <button className="task-icon-button" onClick={onNew} aria-label="新建任务">
          ＋
        </button>
      </div>
      <div className="mode-seg">
        <button
          className={`mode-btn ${section === 'board' ? 'is-active' : ''}`}
          onClick={() => onSection('board')}
        >
          看板
        </button>
        <button
          className={`mode-btn ${section === 'schedule' ? 'is-active' : ''}`}
          onClick={() => onSection('schedule')}
        >
          定时
        </button>
      </div>
      <button className="panel-new" onClick={onNew}>
        ＋ {section === 'board' ? '新建任务' : '新建定时任务'}
      </button>
      <div className="task-panel__metrics">
        <div>
          <strong>{active}</strong>
          <span>执行中</span>
        </div>
        <div>
          <strong>{review}</strong>
          <span>待审阅</span>
        </div>
        <div>
          <strong>{scheduled}</strong>
          <span>已启用</span>
        </div>
      </div>
      <div className="panel-divider" />
      <div className="task-panel__hint">
        {loading
          ? '正在读取 daemon 任务…'
          : error
            ? `Runtime 不可用：${error}`
            : '任务由目标 Runtime daemon 持有；关闭桌面程序后，计划仍可继续。'}
      </div>
      <div className="task-panel__recent">
        <div className="panel-group-label">最近更新</div>
        {tasks.slice(0, 7).map((task) => {
          const presentation = presentTaskStatus(task)
          return (
            <div className="task-panel__item" key={task.id}>
              <span className={`task-status-dot is-${presentation.state}`} />
              <div>
                <strong>{task.title}</strong>
                <span>
                  {task.assignee.toolId} · {presentation.label}
                </span>
              </div>
            </div>
          )
        })}
        {!loading && tasks.length === 0 && <div className="task-panel__empty">还没有任务</div>}
      </div>
    </div>
  )
}

const COLUMNS: Array<{
  status: Exclude<TaskBoardStatus, 'backlog' | 'cancelled'>
  label: string
  hint: string
}> = [
  { status: 'todo', label: 'Todo', hint: '等待派发' },
  { status: 'in_progress', label: 'In Progress', hint: 'Agent 正在工作' },
  { status: 'review', label: 'Review', hint: '人工检查结果' },
  { status: 'done', label: 'Done', hint: '已确认完成' }
]

function TaskCard({
  task,
  onEdit,
  onDetail,
  onOpenSession
}: {
  task: AgentTask
  onEdit(task: AgentTask): void
  onDetail(id: string): void
  onOpenSession(id: string): void
}): React.JSX.Element {
  const update = useTasksStore((state) => state.update)
  const runNow = useTasksStore((state) => state.runNow)
  const remove = useTasksStore((state) => state.remove)
  const active = ACTIVE.has(task.executionStatus)
  const presentation = presentTaskStatus(task)
  return (
    <article
      className={`task-card is-${presentation.state}`}
      draggable={!active}
      onDragStart={(event) => event.dataTransfer.setData('text/task-id', task.id)}
    >
      <div className="task-card__head">
        <h3>{task.title}</h3>
        <button onClick={() => onEdit(task)} aria-label="编辑任务">
          •••
        </button>
      </div>
      <p>{task.prompt}</p>
      <div className="task-card__meta">
        <span>
          {task.assignee.toolId}
          {task.assignee.model ? ` · ${task.assignee.model}` : ''}
        </span>
        <span>
          {hostLabel(task.runtimeHostId)} · {task.workspacePath}
        </span>
      </div>
      <div className={`task-card__state is-${presentation.state}`}>
        <span className={`task-status-dot is-${presentation.state}`} />
        {presentation.label}
      </div>
      {task.lastError && <div className="task-card__error">最近一次执行：{task.lastError}</div>}
      <div className="task-card__actions">
        <button onClick={() => onDetail(task.id)}>任务详情</button>
        {!active && task.boardStatus !== 'done' && (
          <button className="is-primary" onClick={() => void runNow(task.id).catch(notifyError)}>
            运行
          </button>
        )}
        {task.latestSessionId && (
          <button onClick={() => onOpenSession(task.latestSessionId!)}>打开会话</button>
        )}
        {task.boardStatus === 'review' && (
          <button onClick={() => void update(task.id, { boardStatus: 'done' }).catch(notifyError)}>
            确认完成
          </button>
        )}
        {!active && (
          <button className="is-danger" onClick={() => void remove(task.id).catch(notifyError)}>
            删除
          </button>
        )}
      </div>
    </article>
  )
}

export function TaskBoardView({
  onNew,
  onEdit,
  onOpenSession
}: {
  onNew(): void
  onEdit(task: AgentTask): void
  onOpenSession(id: string): void
}): React.JSX.Element {
  const tasks = useTasksStore((state) => state.tasks)
  const update = useTasksStore((state) => state.update)
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const visible = tasks.filter((task) => task.boardStatus !== 'cancelled')
  const detailTask = tasks.find((task) => task.id === detailTaskId)

  return (
    <>
      <div className="task-workspace">
        <header className="task-page-head">
          <div>
            <div className="task-page-head__eyebrow">AGENT DELIVERY</div>
            <h1>任务看板</h1>
            <p>先派单，再执行；Agent 完成后统一进入 Review，由你确认 Done。</p>
          </div>
          <button className="task-primary-button" onClick={onNew}>
            ＋ 新建任务
          </button>
        </header>
        <div className="task-board">
          {COLUMNS.map((column) => {
            const items = visible.filter((task) =>
              column.status === 'todo'
                ? task.boardStatus === 'todo' || task.boardStatus === 'backlog'
                : task.boardStatus === column.status
            )
            return (
              <section
                className="task-column"
                key={column.status}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  const id = event.dataTransfer.getData('text/task-id')
                  if (id) void update(id, { boardStatus: column.status }).catch(notifyError)
                }}
              >
                <div className="task-column__head">
                  <div>
                    <h2>{column.label}</h2>
                    <span>{column.hint}</span>
                  </div>
                  <b>{items.length}</b>
                </div>
                <div className="task-column__body">
                  {items.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onEdit={onEdit}
                      onDetail={setDetailTaskId}
                      onOpenSession={onOpenSession}
                    />
                  ))}
                  {items.length === 0 && <div className="task-column__empty">拖放任务到这里</div>}
                </div>
              </section>
            )
          })}
        </div>
      </div>
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          onClose={() => setDetailTaskId(null)}
          onOpenSession={onOpenSession}
        />
      )}
    </>
  )
}

function scheduleLabel(schedule: TaskSchedule): string {
  if (schedule.kind === 'once') return `单次 · ${formatTime(schedule.runAt)}`
  if (schedule.kind === 'interval') {
    const hours = schedule.everyMs / 3_600_000
    return Number.isInteger(hours) ? `每隔 ${hours} 小时` : `每隔 ${schedule.everyMs / 60_000} 分钟`
  }
  return `Cron · ${schedule.expression} · ${schedule.timeZone}`
}

export function TaskScheduleView({
  onNew,
  onEdit,
  onOpenSession
}: {
  onNew(): void
  onEdit(task: AgentTask): void
  onOpenSession(id: string): void
}): React.JSX.Element {
  const tasks = useTasksStore((state) => state.tasks).filter((task) => task.schedule)
  const update = useTasksStore((state) => state.update)
  const runNow = useTasksStore((state) => state.runNow)
  const loadRuns = useTasksStore((state) => state.loadRuns)
  const runsByTask = useTasksStore((state) => state.runsByTask)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const detailTask = tasks.find((task) => task.id === detailTaskId)

  return (
    <>
      <div className="task-workspace task-schedule-page">
        <header className="task-page-head">
          <div>
            <div className="task-page-head__eyebrow">DAEMON SCHEDULER</div>
            <h1>定时任务</h1>
            <p>每个计划绑定一个目标 Runtime 和一个 Agent CLI，并保留独立运行记录。</p>
          </div>
          <button className="task-primary-button" onClick={onNew}>
            ＋ 新建定时任务
          </button>
        </header>
        <div className="schedule-list">
          {tasks.map((task) => {
            const schedule = task.schedule!
            const runs = runsByTask[task.id] ?? []
            const active = ACTIVE.has(task.executionStatus)
            return (
              <article className="schedule-card" key={task.id}>
                <button
                  className="schedule-card__main"
                  aria-expanded={expanded === task.id}
                  onClick={() => {
                    const next = expanded === task.id ? null : task.id
                    setExpanded(next)
                    if (next) void loadRuns(task.id)
                  }}
                >
                  <span className={`schedule-toggle ${schedule.enabled ? 'is-on' : ''}`} />
                  <div>
                    <h2>{task.title}</h2>
                    <p>{scheduleLabel(schedule)}</p>
                    <span>
                      {task.assignee.toolId} · {hostLabel(task.runtimeHostId)} ·{' '}
                      {task.workspacePath}
                    </span>
                  </div>
                  <div className="schedule-card__next">
                    <span>下一次</span>
                    <strong>{schedule.enabled ? formatTime(schedule.nextRunAt) : '已暂停'}</strong>
                  </div>
                </button>
                <div className="schedule-card__actions">
                  <button onClick={() => setDetailTaskId(task.id)}>任务详情</button>
                  <button disabled={active} onClick={() => void runNow(task.id).catch(notifyError)}>
                    {active ? '执行中' : '立即运行'}
                  </button>
                  <button
                    onClick={() =>
                      void update(task.id, {
                        schedule: { ...schedule, enabled: !schedule.enabled }
                      }).catch(notifyError)
                    }
                  >
                    {schedule.enabled ? '暂停' : '启用'}
                  </button>
                  <button onClick={() => onEdit(task)}>编辑</button>
                  {task.latestSessionId && (
                    <button onClick={() => onOpenSession(task.latestSessionId!)}>打开会话</button>
                  )}
                </div>
                {expanded === task.id && (
                  <div className="schedule-runs">
                    <h3>最近运行</h3>
                    {runs.slice(0, 8).map((run) => (
                      <div key={run.id}>
                        <span>
                          {formatTime(run.startedAt ?? run.scheduledFor ?? run.finishedAt)}
                        </span>
                        <strong className={`is-${run.status}`}>{runStatusLabel(run.status)}</strong>
                        <em>{run.error ?? ''}</em>
                      </div>
                    ))}
                    {runs.length === 0 && <p>暂无运行记录</p>}
                  </div>
                )}
              </article>
            )
          })}
          {tasks.length === 0 && (
            <div className="schedule-empty">
              <h2>让重复工作按时发生</h2>
              <p>新建一个单次、固定间隔或 Cron 计划，目标 daemon 会负责触发。</p>
              <button onClick={onNew}>新建定时任务</button>
            </div>
          )}
        </div>
      </div>
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          onClose={() => setDetailTaskId(null)}
          onOpenSession={onOpenSession}
        />
      )}
    </>
  )
}

type ScheduleMode = 'none' | 'once' | 'interval' | 'cron'

function localDateTimeValue(value?: string): string {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export function TaskComposer({
  kind,
  task,
  onClose
}: {
  kind: TaskSection
  task?: AgentTask
  onClose(): void
}): React.JSX.Element {
  const runtimes = useToolsStore((state) => state.runtimes).filter(
    (runtime) => runtime.capabilities.chat && ['ready', 'updatable'].includes(runtime.health)
  )
  const assignableRuntimes = task
    ? runtimes.filter(
        (runtime) => (runtime.runtimeHostId ?? 'local') === (task.runtimeHostId ?? 'local')
      )
    : runtimes
  const create = useTasksStore((state) => state.create)
  const update = useTasksStore((state) => state.update)
  const initialRuntime = useMemo(() => {
    if (task)
      return assignableRuntimes.find(
        (item) =>
          (item.runtimeHostId ?? 'local') === (task.runtimeHostId ?? 'local') &&
          item.toolId === task.assignee.toolId
      )
    return assignableRuntimes[0]
  }, [assignableRuntimes, task])
  const [title, setTitle] = useState(task?.title ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [workspacePath, setWorkspacePath] = useState(task?.workspacePath ?? '')
  const [runtimeKey, setRuntimeKey] = useState(
    initialRuntime ? `${initialRuntime.runtimeHostId ?? 'local'}::${initialRuntime.toolId}` : ''
  )
  const [model, setModel] = useState(task?.assignee.model ?? '')
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [permissionPreset, setPermissionPreset] = useState<CreateTaskInput['permissionPreset']>(
    task?.permissionPreset ?? 'safe'
  )
  const [sessionPolicy, setSessionPolicy] = useState<CreateTaskInput['sessionPolicy']>(
    task?.sessionPolicy ?? 'new'
  )
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    task?.schedule?.kind ?? (kind === 'schedule' ? 'cron' : 'none')
  )
  const [runAt, setRunAt] = useState(
    localDateTimeValue(task?.schedule?.kind === 'once' ? task.schedule.runAt : undefined)
  )
  const [cron, setCron] = useState(
    task?.schedule?.kind === 'cron' ? task.schedule.expression : '0 9 * * 1-5'
  )
  const initialIntervalMinutes =
    task?.schedule?.kind === 'interval' ? task.schedule.everyMs / 60_000 : 30
  const [intervalAmount, setIntervalAmount] = useState(
    initialIntervalMinutes >= 60 && Number.isInteger(initialIntervalMinutes / 60)
      ? initialIntervalMinutes / 60
      : initialIntervalMinutes
  )
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours'>(
    initialIntervalMinutes >= 60 && Number.isInteger(initialIntervalMinutes / 60)
      ? 'hours'
      : 'minutes'
  )
  const [timeZone, setTimeZone] = useState(
    task?.schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  )
  const [misfirePolicy, setMisfirePolicy] = useState<TaskSchedule['misfirePolicy']>(
    task?.schedule?.misfirePolicy ?? 'run_once'
  )
  const [runAfter, setRunAfter] = useState(false)
  const [saving, setSaving] = useState(false)

  const selected = assignableRuntimes.find(
    (runtime) => `${runtime.runtimeHostId ?? 'local'}::${runtime.toolId}` === runtimeKey
  )
  useEffect(() => {
    if (!selected) return
    void window.agentOs.discovery
      .listModelsOn({ toolId: selected.toolId, hostId: selected.runtimeHostId })
      .then((catalog) => setModels(catalog.models))
      .catch(() => setModels([]))
  }, [selected?.toolId, selected?.runtimeHostId])

  useEffect(() => {
    if (!runtimeKey && initialRuntime) {
      setRuntimeKey(`${initialRuntime.runtimeHostId ?? 'local'}::${initialRuntime.toolId}`)
    }
  }, [initialRuntime, runtimeKey])

  const buildSchedule = (): TaskSchedule | undefined => {
    if (scheduleMode === 'none') return undefined
    const base = { timeZone, enabled: task?.schedule?.enabled ?? true, misfirePolicy }
    if (scheduleMode === 'once')
      return { ...base, kind: 'once', runAt: new Date(runAt).toISOString() }
    if (scheduleMode === 'interval') {
      const everyMs = intervalAmount * (intervalUnit === 'hours' ? 60 * 60_000 : 60_000)
      return {
        ...base,
        kind: 'interval',
        everyMs,
        anchorAt:
          task?.schedule?.kind === 'interval' ? task.schedule.anchorAt : new Date().toISOString()
      }
    }
    return { ...base, kind: 'cron', expression: cron }
  }

  const save = async (): Promise<void> => {
    if (!selected) return notifyError('请选择可用的 Agent CLI')
    setSaving(true)
    try {
      const schedule = buildSchedule()
      if (task) {
        const patch: UpdateTaskPatch = {
          title,
          prompt,
          workspacePath,
          assignee: { toolId: selected.toolId, ...(model ? { model } : {}) },
          permissionPreset,
          sessionPolicy,
          schedule: schedule ?? null
        }
        await update(task.id, patch)
      } else {
        await create(
          {
            title,
            prompt,
            workspacePath,
            runtimeHostId: selected.runtimeHostId ?? 'local',
            assignee: { toolId: selected.toolId, ...(model ? { model } : {}) },
            permissionPreset,
            sessionPolicy,
            ...(schedule ? { schedule } : {})
          },
          runAfter
        )
      }
      onClose()
    } catch (error) {
      notifyError(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="task-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="task-modal"
        role="dialog"
        aria-modal="true"
        aria-label={task ? '编辑任务' : '新建任务'}
      >
        <header>
          <div>
            <span>{task ? 'EDIT TASK' : kind === 'schedule' ? 'NEW SCHEDULE' : 'NEW TASK'}</span>
            <h2>{task ? '编辑任务' : kind === 'schedule' ? '新建定时任务' : '新建任务'}</h2>
          </div>
          <button onClick={onClose}>×</button>
        </header>
        <div className="task-form">
          <label>
            <span>标题</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：每日回顾未解决问题"
            />
          </label>
          <label>
            <span>任务说明 / 首轮 Prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={5}
              placeholder="说明目标、完成标准和边界…"
            />
          </label>
          <div className="task-form__row">
            <label>
              <span>Engineer（Agent CLI）</span>
              <select
                value={runtimeKey}
                onChange={(event) => {
                  setRuntimeKey(event.target.value)
                  setModel('')
                }}
              >
                <option value="">请选择</option>
                {assignableRuntimes.map((runtime) => (
                  <option
                    key={`${runtime.runtimeHostId ?? 'local'}:${runtime.toolId}`}
                    value={`${runtime.runtimeHostId ?? 'local'}::${runtime.toolId}`}
                  >
                    {runtime.displayName} · {hostLabel(runtime.runtimeHostId)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>模型（可选）</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="">由 CLI 决定</option>
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>工作目录</span>
            <div className="task-path-input">
              <input
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
                placeholder="/path/to/project"
              />
              {(!selected || selected.runtimeHostId === 'local') && (
                <button
                  onClick={() =>
                    void window.agentOs.app
                      .selectDirectory({ defaultPath: workspacePath })
                      .then((path) => {
                        if (path) setWorkspacePath(path)
                      })
                  }
                >
                  选择…
                </button>
              )}
            </div>
          </label>
          <div className="task-form__row">
            <label>
              <span>权限</span>
              <select
                value={permissionPreset}
                onChange={(event) =>
                  setPermissionPreset(event.target.value as CreateTaskInput['permissionPreset'])
                }
              >
                <option value="safe">Safe</option>
                <option value="acceptEdits">Accept edits</option>
                <option value="auto">Auto</option>
              </select>
            </label>
            <label>
              <span>会话策略</span>
              <select
                value={sessionPolicy}
                onChange={(event) =>
                  setSessionPolicy(event.target.value as CreateTaskInput['sessionPolicy'])
                }
              >
                <option value="new">每次新会话</option>
                <option value="continue_last">延续上次会话</option>
              </select>
            </label>
          </div>
          {permissionPreset === 'auto' && (
            <div className="task-form__warning">
              无人值守 + Auto 会允许 Agent 自主执行工具，请确认任务说明和工作目录安全。
            </div>
          )}
          <fieldset className="task-schedule-fields">
            <legend>计划</legend>
            <div className="task-schedule-tabs">
              <button
                className={scheduleMode === 'none' ? 'is-active' : ''}
                onClick={() => setScheduleMode('none')}
              >
                无
              </button>
              <button
                className={scheduleMode === 'once' ? 'is-active' : ''}
                onClick={() => setScheduleMode('once')}
              >
                单次
              </button>
              <button
                className={scheduleMode === 'interval' ? 'is-active' : ''}
                onClick={() => setScheduleMode('interval')}
              >
                间隔
              </button>
              <button
                className={scheduleMode === 'cron' ? 'is-active' : ''}
                onClick={() => setScheduleMode('cron')}
              >
                周期 / Cron
              </button>
            </div>
            {scheduleMode === 'once' && (
              <label>
                <span>执行时间</span>
                <input
                  type="datetime-local"
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                />
              </label>
            )}
            {scheduleMode === 'cron' && (
              <>
                <div className="task-cron-presets">
                  <button onClick={() => setCron('0 9 * * *')}>每天 09:00</button>
                  <button onClick={() => setCron('0 9 * * 1-5')}>工作日 09:00</button>
                  <button onClick={() => setCron('0 18 * * 5')}>每周五 18:00</button>
                </div>
                <label>
                  <span>五段 Cron</span>
                  <input
                    className="is-mono"
                    value={cron}
                    onChange={(event) => setCron(event.target.value)}
                  />
                </label>
              </>
            )}{' '}
            {scheduleMode === 'interval' && (
              <div className="task-form__row">
                <label>
                  <span>每隔</span>
                  <input
                    type="number"
                    min={1}
                    max={intervalUnit === 'hours' ? 720 : 43_200}
                    step={1}
                    value={intervalAmount}
                    onChange={(event) => setIntervalAmount(Number(event.target.value))}
                  />
                </label>
                <label>
                  <span>单位</span>
                  <select
                    value={intervalUnit}
                    onChange={(event) => setIntervalUnit(event.target.value as 'minutes' | 'hours')}
                  >
                    <option value="minutes">分钟</option>
                    <option value="hours">小时</option>
                  </select>
                </label>
              </div>
            )}
            {scheduleMode !== 'none' && (
              <div className="task-form__row">
                <label>
                  <span>时区</span>
                  <input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} />
                </label>
                <label>
                  <span>错过计划</span>
                  <select
                    value={misfirePolicy}
                    onChange={(event) =>
                      setMisfirePolicy(event.target.value as TaskSchedule['misfirePolicy'])
                    }
                  >
                    <option value="run_once">补跑一次</option>
                    <option value="skip">跳过</option>
                  </select>
                </label>
              </div>
            )}
          </fieldset>
          {!task && kind === 'board' && (
            <label className="task-checkbox">
              <input
                type="checkbox"
                checked={runAfter}
                onChange={(event) => setRunAfter(event.target.checked)}
              />
              <span>创建后立即运行</span>
            </label>
          )}
        </div>
        <footer>
          <button onClick={onClose}>取消</button>
          <button className="is-primary" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : task ? '保存修改' : '创建任务'}
          </button>
        </footer>
      </div>
    </div>
  )
}
