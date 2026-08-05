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
import { useT } from '../../../lib/i18n'

type TaskSection = 'board' | 'schedule'
type TFunction = ReturnType<typeof useT>['t']

const ACTIVE = new Set(['queued', 'running', 'needs_attention'])
const EMPTY_TASK_RUNS: TaskRun[] = []

function notifyError(error: unknown): void {
  useNotificationStore.getState().show({
    message: error instanceof Error ? error.message : String(error),
    tone: 'error'
  })
}

function hostLabel(hostId: string | undefined, t: TFunction): string {
  return !hostId || hostId === 'local' ? t('tasks.local') : hostId
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

function runStatusLabel(status: TaskRun['status'], t: TFunction): string {
  if (status === 'queued') return t('tasks.status.queued')
  if (status === 'running') return t('tasks.status.running')
  if (status === 'needs_attention') return t('tasks.status.needsAttention')
  if (status === 'succeeded') return t('tasks.status.succeeded')
  if (status === 'failed') return t('tasks.status.failed')
  if (status === 'interrupted') return t('tasks.status.interrupted')
  return t('tasks.status.skipped')
}

function timelineTitle(item: ManagedChatTimelineItem, t: TFunction): string {
  if (item.type === 'thinking') return t('tasks.timeline.thinking')
  if (item.type === 'tool_use') return item.tool ? `${t('tasks.timeline.toolUse')} · ${item.tool}` : t('tasks.timeline.toolUse')
  if (item.type === 'tool_result') return item.tool ? `${t('tasks.timeline.toolResult')} · ${item.tool}` : t('tasks.timeline.toolResult')
  if (item.type === 'permission') return t('tasks.timeline.permission')
  if (item.type === 'error') return t('tasks.timeline.error')
  return t('tasks.timeline.output')
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
  const { t, lang } = useT()
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
        setSessionError(reason || t('tasks.detail.readFailed'))
      } else {
        setSessionError(null)
      }
      setSessionLoading(false)
    },
    [sessionId, t]
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
  const statusPresentation = presentTaskStatus(task, lang)

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
        aria-label={t('tasks.detail.aria', { title: task.title })}
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
            <button onClick={onClose} aria-label={t('tasks.detail.closeAria')}>
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
            <span>{t('tasks.detail.host')}</span>
            <strong>{hostLabel(task.runtimeHostId, t)}</strong>
          </div>
          <div>
            <span>{t('tasks.detail.permissionSession')}</span>
            <strong>
              {task.permissionPreset} · {task.sessionPolicy === 'new' ? t('tasks.detail.newSession') : t('tasks.detail.continueSession')}
            </strong>
          </div>
          <div>
            <span>{t('tasks.detail.updated')}</span>
            <strong>{formatTime(task.updatedAt)}</strong>
          </div>
          <div className="task-detail__workspace">
            <span>{t('tasks.detail.workspace')}</span>
            <strong>{task.workspacePath}</strong>
          </div>
          <div className="task-detail__prompt">
            <span>{t('tasks.detail.prompt')}</span>
            <p>{task.prompt}</p>
          </div>
        </div>

        <div className="task-detail__body">
          <aside className="task-detail__runs">
            <div className="task-detail__section-head">
              <div>
                <span>RUN HISTORY</span>
                <h3>{t('tasks.detail.runs')}</h3>
              </div>
              <b>{runs.length}</b>
            </div>
            {runsLoading && runs.length === 0 && (
              <p className="task-detail__empty">{t('tasks.detail.loadingRuns')}</p>
            )}
            {!runsLoading && runs.length === 0 && <p className="task-detail__empty">{t('tasks.detail.neverRun')}</p>}
            {runs.map((run, index) => (
              <button
                key={run.id}
                className={run.id === selectedRunId ? 'is-active' : ''}
                onClick={() => setSelectedRunId(run.id)}
              >
                <span>
                  #{runs.length - index} · {run.trigger === 'schedule' ? t('tasks.detail.scheduledTrigger') : t('tasks.detail.manualTrigger')}
                </span>
                <strong>{runStatusLabel(run.status, t)}</strong>
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
                {t('tasks.detail.process')} <span>{scopedTimeline.length || fallbackProcess.length}</span>
              </button>
              <button
                className={tab === 'delivery' ? 'is-active' : ''}
                onClick={() => setTab('delivery')}
                role="tab"
                aria-selected={tab === 'delivery'}
              >
                {t('tasks.detail.deliveries')} <span>{deliveries.length}</span>
              </button>
              <button
                className="task-detail__refresh"
                onClick={() => void refreshSession()}
                disabled={!sessionId || sessionLoading}
              >
                {sessionLoading ? t('tasks.detail.loading') : t('tasks.detail.refresh')}
              </button>
            </div>

            {sessionError && (
              <div className="task-detail__error">{t('tasks.detail.sessionError', { error: sessionError })}</div>
            )}

            {tab === 'process' && (
              <div className="task-detail__process" role="tabpanel">
                {selectedRun && (
                  <div className="task-process-item is-lifecycle">
                    <i />
                    <div>
                      <header>
                        <strong>TaskRun · {runStatusLabel(selectedRun.status, t)}</strong>
                        <time>{formatTime(selectedRun.startedAt ?? selectedRun.scheduledFor)}</time>
                      </header>
                      <p>
                        {selectedRun.trigger === 'schedule' ? t('tasks.detail.scheduledBy') : t('tasks.detail.manualBy')}
                        {selectedRun.finishedAt
                          ? ` · ${t('tasks.detail.finishedAt', { time: formatTime(selectedRun.finishedAt) })}`
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
                          <strong>{timelineTitle(item, t)}</strong>
                          <time>{formatTime(item.createdAt)}</time>
                        </header>
                        {item.type === 'permission' && item.status && (
                          <p>{t('tasks.timeline.handled', { status: item.status })}</p>
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
                        <strong>{message.role === 'assistant' ? t('tasks.timeline.output') : t('tasks.timeline.input')}</strong>
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
                      <h3>{t('tasks.detail.noProcess')}</h3>
                      <p>{t('tasks.detail.noProcessHint')}</p>
                    </div>
                  )}
                {!sessionLoading &&
                  selectedRun &&
                  scopedTimeline.length === 0 &&
                  fallbackProcess.length === 0 && (
                    <div className="task-detail__empty-state">
                      <h3>{t('tasks.detail.noRunProcess')}</h3>
                      <p>
                        {selectedRun.sessionId
                          ? t('tasks.detail.noRunProcessSession')
                          : t('tasks.detail.noRunProcessBeforeSession')}
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
                        <strong>{delivery.status === 'streaming' ? t('tasks.detail.streaming') : t('tasks.detail.final')}</strong>
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
                    <h3>{t('tasks.detail.noDelivery')}</h3>
                    <p>
                      {selectedRun?.status === 'running'
                        ? t('tasks.detail.runningDeliveryHint')
                        : t('tasks.detail.noDeliveryHint')}
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <footer>
          <button onClick={onClose}>{t('tasks.detail.close')}</button>
          <button
            className={task.boardStatus === 'review' ? undefined : 'is-primary'}
            disabled={!sessionId}
            onClick={() => {
              if (!sessionId) return
              onOpenSession(sessionId)
              onClose()
            }}
          >
            {t('tasks.detail.openSession')}
          </button>
          {task.boardStatus === 'review' && (
            <button className="is-primary" disabled={confirming} onClick={() => void confirmTask()}>
              {confirming ? t('tasks.detail.confirming') : t('tasks.detail.confirm')}
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
  const { t, lang } = useT()
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
          <h2>{section === 'board' ? t('tasks.panel.board') : t('tasks.panel.schedules')}</h2>
        </div>
        <button className="task-icon-button" onClick={onNew} aria-label={t('tasks.panel.newAria')}>
          ＋
        </button>
      </div>
      <div className="mode-seg">
        <button
          className={`mode-btn ${section === 'board' ? 'is-active' : ''}`}
          onClick={() => onSection('board')}
        >
          {t('tasks.panel.boardTab')}
        </button>
        <button
          className={`mode-btn ${section === 'schedule' ? 'is-active' : ''}`}
          onClick={() => onSection('schedule')}
        >
          {t('tasks.panel.scheduleTab')}
        </button>
      </div>
      <button className="panel-new" onClick={onNew}>
        ＋ {section === 'board' ? t('tasks.panel.newTask') : t('tasks.panel.newSchedule')}
      </button>
      <div className="task-panel__metrics">
        <div>
          <strong>{active}</strong>
          <span>{t('tasks.panel.running')}</span>
        </div>
        <div>
          <strong>{review}</strong>
          <span>{t('tasks.panel.review')}</span>
        </div>
        <div>
          <strong>{scheduled}</strong>
          <span>{t('tasks.panel.enabled')}</span>
        </div>
      </div>
      <div className="panel-divider" />
      <div className="task-panel__hint">
        {loading
          ? t('tasks.panel.loading')
          : error
            ? t('tasks.panel.unavailable', { error })
            : t('tasks.panel.daemonHint')}
      </div>
      <div className="task-panel__recent">
        <div className="panel-group-label">{t('tasks.panel.recent')}</div>
        {tasks.slice(0, 7).map((task) => {
          const presentation = presentTaskStatus(task, lang)
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
        {!loading && tasks.length === 0 && <div className="task-panel__empty">{t('tasks.panel.empty')}</div>}
      </div>
    </div>
  )
}

function columns(t: TFunction): Array<{
  status: Exclude<TaskBoardStatus, 'backlog' | 'cancelled'>
  label: string
  hint: string
}> {
  return [
    { status: 'todo', label: 'Todo', hint: t('tasks.board.todoHint') },
    { status: 'in_progress', label: 'In Progress', hint: t('tasks.board.progressHint') },
    { status: 'review', label: 'Review', hint: t('tasks.board.reviewHint') },
    { status: 'done', label: 'Done', hint: t('tasks.board.doneHint') }
  ]
}

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
  const { t, lang } = useT()
  const update = useTasksStore((state) => state.update)
  const runNow = useTasksStore((state) => state.runNow)
  const remove = useTasksStore((state) => state.remove)
  const active = ACTIVE.has(task.executionStatus)
  const presentation = presentTaskStatus(task, lang)
  return (
    <article
      className={`task-card is-${presentation.state}`}
      draggable={!active}
      onDragStart={(event) => event.dataTransfer.setData('text/task-id', task.id)}
    >
      <div className="task-card__head">
        <h3>{task.title}</h3>
        <button onClick={() => onEdit(task)} aria-label={t('tasks.board.editAria')}>
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
          {hostLabel(task.runtimeHostId, t)} · {task.workspacePath}
        </span>
      </div>
      <div className={`task-card__state is-${presentation.state}`}>
        <span className={`task-status-dot is-${presentation.state}`} />
        {presentation.label}
      </div>
      {task.lastError && <div className="task-card__error">{t('tasks.board.lastRun', { error: task.lastError })}</div>}
      <div className="task-card__actions">
        <button onClick={() => onDetail(task.id)}>{t('tasks.board.detail')}</button>
        {!active && task.boardStatus !== 'done' && (
          <button className="is-primary" onClick={() => void runNow(task.id).catch(notifyError)}>
            {t('tasks.board.run')}
          </button>
        )}
        {task.latestSessionId && (
          <button onClick={() => onOpenSession(task.latestSessionId!)}>{t('tasks.board.openSession')}</button>
        )}
        {task.boardStatus === 'review' && (
          <button onClick={() => void update(task.id, { boardStatus: 'done' }).catch(notifyError)}>
            {t('tasks.board.confirm')}
          </button>
        )}
        {!active && (
          <button className="is-danger" onClick={() => void remove(task.id).catch(notifyError)}>
            {t('tasks.board.delete')}
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
  const { t } = useT()
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
            <h1>{t('tasks.board.title')}</h1>
            <p>{t('tasks.board.description')}</p>
          </div>
          <button className="task-primary-button" onClick={onNew}>
            ＋ {t('tasks.panel.newTask')}
          </button>
        </header>
        <div className="task-board">
          {columns(t).map((column) => {
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
                  {items.length === 0 && <div className="task-column__empty">{t('tasks.board.dropHere')}</div>}
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

function scheduleLabel(schedule: TaskSchedule, t: TFunction): string {
  if (schedule.kind === 'once') return t('tasks.schedule.onceLabel', { time: formatTime(schedule.runAt) })
  if (schedule.kind === 'interval') {
    const hours = schedule.everyMs / 3_600_000
    return Number.isInteger(hours)
      ? t('tasks.schedule.everyHours', { count: hours })
      : t('tasks.schedule.everyMinutes', { count: schedule.everyMs / 60_000 })
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
  const { t } = useT()
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
            <h1>{t('tasks.schedule.title')}</h1>
            <p>{t('tasks.schedule.description')}</p>
          </div>
          <button className="task-primary-button" onClick={onNew}>
            ＋ {t('tasks.panel.newSchedule')}
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
                    <p>{scheduleLabel(schedule, t)}</p>
                    <span>
                      {task.assignee.toolId} · {hostLabel(task.runtimeHostId, t)} ·{' '}
                      {task.workspacePath}
                    </span>
                  </div>
                  <div className="schedule-card__next">
                    <span>{t('tasks.schedule.next')}</span>
                    <strong>{schedule.enabled ? formatTime(schedule.nextRunAt) : t('tasks.schedule.paused')}</strong>
                  </div>
                </button>
                <div className="schedule-card__actions">
                  <button onClick={() => setDetailTaskId(task.id)}>{t('tasks.schedule.detail')}</button>
                  <button disabled={active} onClick={() => void runNow(task.id).catch(notifyError)}>
                    {active ? t('tasks.schedule.running') : t('tasks.schedule.runNow')}
                  </button>
                  <button
                    onClick={() =>
                      void update(task.id, {
                        schedule: { ...schedule, enabled: !schedule.enabled }
                      }).catch(notifyError)
                    }
                  >
                    {schedule.enabled ? t('tasks.schedule.pause') : t('tasks.schedule.enable')}
                  </button>
                  <button onClick={() => onEdit(task)}>{t('tasks.schedule.edit')}</button>
                  {task.latestSessionId && (
                    <button onClick={() => onOpenSession(task.latestSessionId!)}>{t('tasks.schedule.openSession')}</button>
                  )}
                </div>
                {expanded === task.id && (
                  <div className="schedule-runs">
                    <h3>{t('tasks.schedule.recentRuns')}</h3>
                    {runs.slice(0, 8).map((run) => (
                      <div key={run.id}>
                        <span>
                          {formatTime(run.startedAt ?? run.scheduledFor ?? run.finishedAt)}
                        </span>
                        <strong className={`is-${run.status}`}>{runStatusLabel(run.status, t)}</strong>
                        <em>{run.error ?? ''}</em>
                      </div>
                    ))}
                    {runs.length === 0 && <p>{t('tasks.schedule.noRuns')}</p>}
                  </div>
                )}
              </article>
            )
          })}
          {tasks.length === 0 && (
            <div className="schedule-empty">
              <h2>{t('tasks.schedule.emptyTitle')}</h2>
              <p>{t('tasks.schedule.emptyHint')}</p>
              <button onClick={onNew}>{t('tasks.panel.newSchedule')}</button>
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
  const { t } = useT()
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
    if (!selected) return notifyError(t('tasks.composer.selectAgentError'))
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
        aria-label={task ? t('tasks.composer.editAria') : t('tasks.composer.newAria')}
      >
        <header>
          <div>
            <span>{task ? 'EDIT TASK' : kind === 'schedule' ? 'NEW SCHEDULE' : 'NEW TASK'}</span>
            <h2>{task ? t('tasks.composer.edit') : kind === 'schedule' ? t('tasks.composer.newSchedule') : t('tasks.composer.newTask')}</h2>
          </div>
          <button onClick={onClose}>×</button>
        </header>
        <div className="task-form">
          <label>
            <span>{t('tasks.composer.title')}</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('tasks.composer.titlePlaceholder')}
            />
          </label>
          <label>
            <span>{t('tasks.composer.prompt')}</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={5}
              placeholder={t('tasks.composer.promptPlaceholder')}
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
                <option value="">{t('tasks.composer.select')}</option>
                {assignableRuntimes.map((runtime) => (
                  <option
                    key={`${runtime.runtimeHostId ?? 'local'}:${runtime.toolId}`}
                    value={`${runtime.runtimeHostId ?? 'local'}::${runtime.toolId}`}
                  >
                    {runtime.displayName} · {hostLabel(runtime.runtimeHostId, t)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('tasks.composer.model')}</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="">{t('tasks.composer.modelAuto')}</option>
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>{t('tasks.composer.workspace')}</span>
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
                  {t('tasks.composer.choose')}
                </button>
              )}
            </div>
          </label>
          <div className="task-form__row">
            <label>
              <span>{t('tasks.composer.permission')}</span>
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
              <span>{t('tasks.composer.sessionPolicy')}</span>
              <select
                value={sessionPolicy}
                onChange={(event) =>
                  setSessionPolicy(event.target.value as CreateTaskInput['sessionPolicy'])
                }
              >
                <option value="new">{t('tasks.composer.newSession')}</option>
                <option value="continue_last">{t('tasks.composer.continueSession')}</option>
              </select>
            </label>
          </div>
          {permissionPreset === 'auto' && (
            <div className="task-form__warning">
              {t('tasks.composer.autoWarning')}
            </div>
          )}
          <fieldset className="task-schedule-fields">
            <legend>{t('tasks.composer.schedule')}</legend>
            <div className="task-schedule-tabs">
              <button
                className={scheduleMode === 'none' ? 'is-active' : ''}
                onClick={() => setScheduleMode('none')}
              >
                {t('tasks.composer.none')}
              </button>
              <button
                className={scheduleMode === 'once' ? 'is-active' : ''}
                onClick={() => setScheduleMode('once')}
              >
                {t('tasks.composer.once')}
              </button>
              <button
                className={scheduleMode === 'interval' ? 'is-active' : ''}
                onClick={() => setScheduleMode('interval')}
              >
                {t('tasks.composer.interval')}
              </button>
              <button
                className={scheduleMode === 'cron' ? 'is-active' : ''}
                onClick={() => setScheduleMode('cron')}
              >
                {t('tasks.composer.cron')}
              </button>
            </div>
            {scheduleMode === 'once' && (
              <label>
                <span>{t('tasks.composer.runAt')}</span>
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
                  <button onClick={() => setCron('0 9 * * *')}>{t('tasks.composer.daily')}</button>
                  <button onClick={() => setCron('0 9 * * 1-5')}>{t('tasks.composer.weekdays')}</button>
                  <button onClick={() => setCron('0 18 * * 5')}>{t('tasks.composer.friday')}</button>
                </div>
                <label>
                  <span>{t('tasks.composer.cronField')}</span>
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
                  <span>{t('tasks.composer.every')}</span>
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
                  <span>{t('tasks.composer.unit')}</span>
                  <select
                    value={intervalUnit}
                    onChange={(event) => setIntervalUnit(event.target.value as 'minutes' | 'hours')}
                  >
                    <option value="minutes">{t('tasks.composer.minutes')}</option>
                    <option value="hours">{t('tasks.composer.hours')}</option>
                  </select>
                </label>
              </div>
            )}
            {scheduleMode !== 'none' && (
              <div className="task-form__row">
                <label>
                  <span>{t('tasks.composer.timeZone')}</span>
                  <input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} />
                </label>
                <label>
                  <span>{t('tasks.composer.misfire')}</span>
                  <select
                    value={misfirePolicy}
                    onChange={(event) =>
                      setMisfirePolicy(event.target.value as TaskSchedule['misfirePolicy'])
                    }
                  >
                    <option value="run_once">{t('tasks.composer.runOnce')}</option>
                    <option value="skip">{t('tasks.composer.skip')}</option>
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
              <span>{t('tasks.composer.runAfter')}</span>
            </label>
          )}
        </div>
        <footer>
          <button onClick={onClose}>{t('tasks.composer.cancel')}</button>
          <button className="is-primary" disabled={saving} onClick={() => void save()}>
            {saving ? t('tasks.composer.saving') : task ? t('tasks.composer.save') : t('tasks.composer.create')}
          </button>
        </footer>
      </div>
    </div>
  )
}
