import { describe, expect, it } from 'vitest'
import { presentTaskStatus, projectScheduledTasks } from '../src/shared/task-presentation'
import type { AgentTask } from '../src/shared/types'

function status(
  boardStatus: AgentTask['boardStatus'],
  executionStatus: AgentTask['executionStatus']
) {
  return presentTaskStatus({ boardStatus, executionStatus })
}

describe('task status presentation', () => {
  it('treats a done task as confirmed even when its last execution remains succeeded', () => {
    expect(status('done', 'succeeded')).toEqual({
      label: '已确认完成',
      state: 'confirmed'
    })
  })

  it('only calls a successful task pending confirmation while it is in review', () => {
    expect(status('review', 'succeeded')).toEqual({
      label: '执行成功 · 待确认',
      state: 'succeeded'
    })
  })

  it('uses workflow labels for non-running board columns', () => {
    expect(status('backlog', 'succeeded').label).toBe('待规划')
    expect(status('todo', 'failed').label).toBe('待执行')
    expect(status('cancelled', 'running')).toEqual({ label: '已取消', state: 'cancelled' })
  })

  it('keeps actionable execution detail for active and review tasks', () => {
    expect(status('in_progress', 'needs_attention').label).toBe('需要处理')
    expect(status('review', 'failed').label).toBe('执行失败 · 待处理')
    expect(status('review', 'interrupted').label).toBe('已中断 · 待处理')
  })

  it('projects the same workflow states with English labels', () => {
    expect(presentTaskStatus({ boardStatus: 'review', executionStatus: 'succeeded' }, 'en'))
      .toEqual({ label: 'Succeeded · Awaiting confirmation', state: 'succeeded' })
    expect(presentTaskStatus({ boardStatus: 'done', executionStatus: 'succeeded' }, 'en'))
      .toEqual({ label: 'Confirmed complete', state: 'confirmed' })
  })
})

describe('scheduled task presentation', () => {
  const tasks = [
    { id: 'disabled-a', schedule: { enabled: false } },
    { id: 'unscheduled' },
    { id: 'enabled', schedule: { enabled: true } },
    { id: 'disabled-b', schedule: { enabled: false } }
  ] as unknown as AgentTask[]

  it('combines enabled filtering with stable status sorting', () => {
    expect(projectScheduledTasks(tasks, 'enabled', 'disabled-first').map((task) => task.id)).toEqual(['enabled'])
    expect(projectScheduledTasks(tasks, 'all', 'enabled-first').map((task) => task.id)).toEqual([
      'enabled', 'disabled-a', 'disabled-b'
    ])
    expect(projectScheduledTasks(tasks, 'all', 'disabled-first').map((task) => task.id)).toEqual([
      'disabled-a', 'disabled-b', 'enabled'
    ])
  })
})
