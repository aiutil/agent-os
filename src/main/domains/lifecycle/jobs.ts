import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type {
  LifecycleJob,
  LifecycleJobKind,
  LifecycleJobStatus
} from '@shared/types'
import { classifyLifecycleFailure } from './config'

const MAX_LOG_TAIL = 64_000
const FINAL: LifecycleJobStatus[] = ['succeeded', 'failed', 'cancelled']

interface LifecycleJobManagerOptions {
  resolveCommand(toolId: string, kind: LifecycleJobKind): string
  environment?(toolId: string): Record<string, string>
  onProgress?(job: LifecycleJob): void
  onSucceeded?(toolId: string): Promise<void> | void
}

export function resolveLifecycleShell(
  platform: NodeJS.Platform,
  configuredShell?: string
): { executable: string; args: string[] } {
  return platform === 'win32'
    ? { executable: 'powershell.exe', args: ['-NoProfile', '-Command'] }
    : { executable: configuredShell || '/bin/zsh', args: ['-lc'] }
}

export class LifecycleJobManager {
  private readonly jobs = new Map<string, LifecycleJob>()
  private readonly runningByTool = new Map<string, string>()
  private readonly children = new Map<string, ChildProcess>()

  constructor(private readonly options: LifecycleJobManagerOptions) {}

  start(toolId: string, kind: LifecycleJobKind): string {
    const runningId = this.runningByTool.get(toolId)
    if (runningId && !FINAL.includes(this.jobs.get(runningId)?.status ?? 'failed')) {
      throw new Error(`${toolId} 已有安装或升级任务正在运行`)
    }
    const command = this.options.resolveCommand(toolId, kind)
    const now = new Date().toISOString()
    const job: LifecycleJob = {
      id: randomUUID(),
      toolId,
      kind,
      status: 'queued',
      command,
      logTail: `$ ${command}\n`,
      createdAt: now,
      updatedAt: now
    }
    this.jobs.set(job.id, job)
    this.runningByTool.set(toolId, job.id)
    this.emit(job)
    this.run(job)
    return job.id
  }

  get(jobId: string): LifecycleJob | null {
    const job = this.jobs.get(jobId)
    return job ? { ...job } : null
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || FINAL.includes(job.status)) return false
    this.children.get(jobId)?.kill('SIGTERM')
    this.finish(job, 'cancelled')
    return true
  }

  private run(job: LifecycleJob): void {
    job.status = 'running'
    this.touch(job)
    const shell = resolveLifecycleShell(process.platform, process.env.SHELL)
    const child = spawn(shell.executable, [...shell.args, job.command], {
      env: {
        ...process.env,
        ...(this.options.environment?.(job.toolId) ?? {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.children.set(job.id, child)
    child.stdout?.on('data', (chunk: Buffer) => this.append(job, chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => this.append(job, chunk.toString()))
    child.on('error', (error) => {
      this.append(job, `${error.message}\n`)
      job.exitCode = 1
      job.diagnosis = classifyLifecycleFailure(job.logTail)
      this.finish(job, 'failed')
    })
    child.on('exit', (code) => {
      if (job.status === 'cancelled') return
      job.exitCode = code ?? 1
      if (code === 0) {
        void Promise.resolve(this.options.onSucceeded?.(job.toolId))
          .catch((error: unknown) => {
            this.append(
              job,
              `重新扫描失败：${error instanceof Error ? error.message : String(error)}\n`
            )
          })
          .finally(() => this.finish(job, 'succeeded'))
      } else {
        job.diagnosis = classifyLifecycleFailure(job.logTail)
        this.finish(job, 'failed')
      }
    })
  }

  private append(job: LifecycleJob, output: string): void {
    job.logTail = `${job.logTail}${output}`.slice(-MAX_LOG_TAIL)
    this.touch(job)
  }

  private finish(job: LifecycleJob, status: LifecycleJobStatus): void {
    job.status = status
    this.children.delete(job.id)
    this.runningByTool.delete(job.toolId)
    this.touch(job)
  }

  private touch(job: LifecycleJob): void {
    job.updatedAt = new Date().toISOString()
    this.emit(job)
  }

  private emit(job: LifecycleJob): void {
    this.options.onProgress?.({ ...job })
  }
}
