// 对比工作台服务（SPEC-009）。
// git worktree 隔离齐发：为每列建 worktree，注入任务 prompt，采纳时 squash merge 回主分支。

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CompareAdoptResult,
  CompareColumn,
  CompareRun,
  CompareRunView,
  CompareScenario,
  SaveCompareScenarioInput,
  CompareStartInput
} from '@shared/types'
import { getCompareRuns, getCompareScenarios, setCompareRuns, setCompareScenarios } from '../../store/app-store'
import { tr } from '@shared/i18n'

const WORKTREES_DIR = '.agent-os/worktrees'

// ─── git helpers ──────────────────────────────────────────────────────────

function gitExec(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const msg =
      error instanceof Error
        ? (error as Error & { stderr?: string }).stderr ?? error.message
        : String(error)
    throw new Error(msg.trim())
  }
}

function isGitRepo(dir: string): boolean {
  try {
    gitExec(dir, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

function hasDirtyWorktree(dir: string): boolean {
  try {
    const out = gitExec(dir, ['status', '--porcelain'])
    return out.trim().length > 0
  } catch {
    return false
  }
}

function addWorktree(repoRoot: string, worktreePath: string, branch: string): void {
  gitExec(repoRoot, ['worktree', 'add', worktreePath, '-b', branch])
}

function removeWorktree(repoRoot: string, worktreePath: string): void {
  try {
    gitExec(repoRoot, ['worktree', 'remove', '--force', worktreePath])
  } catch {
    // worktree may already be gone
  }
}

function deleteBranch(repoRoot: string, branch: string): void {
  try {
    gitExec(repoRoot, ['branch', '-D', branch])
  } catch {
    // branch may already be deleted
  }
}

function squashMerge(repoRoot: string, branch: string): CompareAdoptResult {
  try {
    gitExec(repoRoot, ['merge', '--squash', branch])
    // 自动提交 squash 结果
    gitExec(repoRoot, ['commit', '-m', `比较采纳：${branch}`])
    return { merged: true }
  } catch (error) {
    // 有冲突 → abort 恢复仓库
    try {
      gitExec(repoRoot, ['merge', '--abort'])
    } catch {
      spawnSync('git', ['reset', '--hard', 'HEAD'], { cwd: repoRoot })
    }
    return {
      merged: false,
      conflict: error instanceof Error ? error.message : String(error)
    }
  }
}

// ─── store helpers ─────────────────────────────────────────────────────────

function saveRun(run: CompareRun): void {
  const runs = getCompareRuns()
  const idx = runs.findIndex((r) => r.id === run.id)
  if (idx === -1) setCompareRuns([run, ...runs])
  else {
    runs[idx] = run
    setCompareRuns(runs)
  }
}

function getRun(id: string): CompareRun | null {
  return getCompareRuns().find((r) => r.id === id) ?? null
}

function summarizePrompt(prompt: string): string {
  const compact = prompt
    .replace(/\s+/g, ' ')
    .replace(/[。！？!?]+$/g, '')
    .trim()
  if (!compact) return '未命名对比'
  return compact.length > 18 ? `${compact.slice(0, 18)}…` : compact
}

function sanitizeScenario(input: SaveCompareScenarioInput, previous?: CompareScenario): CompareScenario {
  const now = new Date().toISOString()
  const prompt = input.prompt.trim()
  return {
    id: input.id || previous?.id || randomUUID(),
    title: previous?.title || input.title?.trim() || summarizePrompt(prompt),
    workspacePath: input.workspacePath,
    prompt,
    paneCount: input.paneCount,
    panes: input.panes.map((pane) => ({
      id: pane.id,
      type: pane.type,
      toolId: pane.toolId,
      webService: pane.webService,
      sessionId: pane.sessionId ?? null,
      lastUrl: pane.lastUrl ?? null
    })),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  }
}

// ─── public API ───────────────────────────────────────────────────────────

interface CompareServiceOptions {
  createSession(input: {
    name: string
    toolId: string
    workspacePath: string
    surface?: 'terminal' | 'chat'
  }): Promise<{ session: { id: string } }>
  writeToSession(sessionId: string, data: string): Promise<boolean>
}

export class CompareService {
  constructor(private readonly options: CompareServiceOptions) {}

  async start(input: CompareStartInput): Promise<CompareRun> {
    const { workspacePath, prompt, toolIds } = input

    if (!isGitRepo(workspacePath)) {
      throw Object.assign(new Error(tr('compare.service.notGitRepo')), {
        code: 'NOT_GIT_REPO'
      })
    }
    if (hasDirtyWorktree(workspacePath)) {
      throw Object.assign(new Error(tr('compare.service.dirtyWorktree')), {
        code: 'DIRTY_WORKTREE'
      })
    }
    if (toolIds.length < 2 || toolIds.length > 4) {
      throw new Error(tr('compare.service.needClis'))
    }

    const runId = randomUUID().slice(0, 8)
    const now = new Date().toISOString()
    const columns: CompareColumn[] = []
    const createdWorktrees: string[] = []

    try {
      for (const toolId of toolIds) {
        const branch = `compare/${runId}-${toolId}`
        const worktreePath = join(workspacePath, WORKTREES_DIR, `${runId}-${toolId}`)

        addWorktree(workspacePath, worktreePath, branch)
        createdWorktrees.push(worktreePath)

        const handle = await this.options.createSession({
          name: `[对比] ${toolId} · ${runId}`,
          toolId,
          workspacePath: worktreePath,
          surface: 'terminal'
        })

        columns.push({
          toolId,
          sessionId: handle.session.id,
          worktreePath,
          branch,
          startedAt: now
        })
      }
    } catch (error) {
      // 回滚：清理已建 worktree
      for (const wt of createdWorktrees) {
        try {
          removeWorktree(workspacePath, wt)
        } catch {
          // best effort
        }
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        code: (error as { code?: string }).code ?? 'WORKTREE_FAILED'
      })
    }

    // 注入任务 prompt（给各列终端敲入命令）
    for (const col of columns) {
      try {
        await this.options.writeToSession(col.sessionId, `${prompt}\r`)
      } catch {
        // 注入失败不阻断整体
      }
    }

    const run: CompareRun = {
      id: runId,
      workspacePath,
      prompt,
      columns,
      status: 'running',
      createdAt: now,
      updatedAt: now
    }
    saveRun(run)
    return run
  }

  async adopt(runId: string, toolId: string): Promise<CompareAdoptResult> {
    const run = getRun(runId)
    if (!run) throw new Error(tr('compare.service.runNotFound'))

    const targetCol = run.columns.find((c) => c.toolId === toolId)
    if (!targetCol) throw new Error(tr('compare.service.columnNotFound'))

    const result = squashMerge(run.workspacePath, targetCol.branch)

    if (result.merged) {
      // 标记采纳 + 清理其余 worktree
      const now = new Date().toISOString()
      const updated: CompareRun = {
        ...run,
        columns: run.columns.map((c) => ({
          ...c,
          adopted: c.toolId === toolId,
          endedAt: now
        })),
        status: 'adopted',
        updatedAt: now
      }
      saveRun(updated)

      for (const col of run.columns) {
        if (col.toolId !== toolId) {
          removeWorktree(run.workspacePath, col.worktreePath)
          deleteBranch(run.workspacePath, col.branch)
        }
      }
    }

    return result
  }

  async discard(runId: string): Promise<void> {
    const run = getRun(runId)
    if (!run) return

    for (const col of run.columns) {
      removeWorktree(run.workspacePath, col.worktreePath)
      deleteBranch(run.workspacePath, col.branch)
    }

    const now = new Date().toISOString()
    saveRun({ ...run, status: 'discarded', updatedAt: now })
  }

  list(): CompareRunView[] {
    return getCompareRuns().map((run) => ({
      ...run,
      columns: run.columns.map((col) => ({
        ...col,
        status: 'disconnected' as const,
        outputTail: '',
        elapsedMs: col.endedAt
          ? new Date(col.endedAt).getTime() - new Date(col.startedAt).getTime()
          : undefined
      }))
    }))
  }

  listScenarios(): CompareScenario[] {
    return getCompareScenarios().sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  }

  getScenario(id: string): CompareScenario | null {
    return getCompareScenarios().find((scenario) => scenario.id === id) ?? null
  }

  saveScenario(input: SaveCompareScenarioInput): CompareScenario {
    const scenarios = getCompareScenarios()
    const idx = input.id ? scenarios.findIndex((scenario) => scenario.id === input.id) : -1
    const previous = idx >= 0 ? scenarios[idx] : undefined
    const scenario = sanitizeScenario(input, previous)
    const next = idx >= 0
      ? scenarios.map((item) => (item.id === scenario.id ? scenario : item))
      : [scenario, ...scenarios]
    setCompareScenarios(next.slice(0, 50))
    return scenario
  }

  deleteScenario(id: string): void {
    setCompareScenarios(getCompareScenarios().filter((scenario) => scenario.id !== id))
  }

  /** 启动时扫描孤儿 worktree（崩溃后残留），日志警告不自动删除。 */
  auditOrphans(): string[] {
    const orphans: string[] = []
    const runs = getCompareRuns()
    const knownPaths = new Set(runs.flatMap((r) => r.columns.map((c) => c.worktreePath)))

    for (const run of runs) {
      const baseDir = join(run.workspacePath, WORKTREES_DIR)
      if (!existsSync(baseDir)) continue
      try {
        for (const entry of readdirSync(baseDir)) {
          const full = join(baseDir, entry)
          if (!knownPaths.has(full)) orphans.push(full)
        }
      } catch {
        // dir may not exist for this run
      }
    }
    return orphans
  }
}
