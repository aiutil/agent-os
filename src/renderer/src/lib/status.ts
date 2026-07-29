// 状态 → 颜色/文案映射（SPEC-001/005）。集中映射，组件不散落色值。

import type { CliHealth } from '@shared/types'
import type { WorkbenchSessionView } from '@shared/types'
import { tr } from '@shared/i18n'

type SessionStatus = WorkbenchSessionView['status']

export function sessionStatusColor(status: SessionStatus): string {
  switch (status) {
    case 'running':
    case 'starting':
      return 'var(--status-working)'
    case 'waiting_input':
      return 'var(--status-waiting)'
    case 'resumable':
      return 'var(--status-resumable)'
    case 'failed':
      return 'var(--danger)'
    case 'completed':
    case 'disconnected':
    default:
      return 'var(--status-disconnect)'
  }
}

export function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case 'starting':
      return tr('workbench.status.session.starting')
    case 'running':
      return tr('workbench.status.session.running')
    case 'waiting_input':
      return tr('workbench.status.session.waitingInput')
    case 'resumable':
      return tr('workbench.status.session.resumable')
    case 'completed':
      return tr('workbench.status.session.completed')
    case 'failed':
      return tr('workbench.status.session.failed')
    case 'disconnected':
    default:
      return tr('workbench.status.session.disconnected')
  }
}

/** 工作中/等待输入用呼吸动效。 */
export function sessionStatusPulsing(status: SessionStatus): boolean {
  return status === 'running' || status === 'starting' || status === 'waiting_input'
}

export function healthColor(health: CliHealth): string {
  switch (health) {
    case 'ready':
      return 'var(--status-working)'
    case 'updatable':
      return 'var(--status-update)'
    case 'failed':
      return 'var(--danger)'
    case 'missing':
    default:
      return 'var(--status-disconnect)'
  }
}

export function healthLabel(health: CliHealth): string {
  switch (health) {
    case 'ready':
      return tr('workbench.status.health.ready')
    case 'updatable':
      return tr('workbench.status.health.updatable')
    case 'failed':
      return tr('common.state.failed')
    case 'missing':
    default:
      return tr('common.state.notInstalled')
  }
}
