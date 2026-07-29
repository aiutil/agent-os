import { create } from 'zustand'
import type {
  AgentTask,
  CreateTaskInput,
  TaskChangedEvent,
  TaskRun,
  UpdateTaskPatch
} from '@shared/types'

interface TasksState {
  tasks: AgentTask[]
  runsByTask: Record<string, TaskRun[]>
  loading: boolean
  error: string | null
  refresh(): Promise<void>
  loadRuns(taskId: string): Promise<void>
  create(input: CreateTaskInput, runNow?: boolean): Promise<AgentTask>
  update(id: string, patch: UpdateTaskPatch): Promise<AgentTask | null>
  remove(id: string): Promise<void>
  runNow(id: string): Promise<TaskRun>
  applyEvent(event: TaskChangedEvent): void
}

function byUpdatedAt(tasks: AgentTask[]): AgentTask[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  runsByTask: {},
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null })
    try {
      set({ tasks: byUpdatedAt(await window.agentOs.tasks.list()) })
    } catch (error) {
      set({ error: message(error) })
    } finally {
      set({ loading: false })
    }
  },
  loadRuns: async (taskId) => {
    try {
      const runs = await window.agentOs.tasks.listRuns(taskId)
      set((state) => ({ runsByTask: { ...state.runsByTask, [taskId]: runs } }))
    } catch (error) {
      set({ error: message(error) })
    }
  },
  create: async (input, runNow = false) => {
    set({ error: null })
    try {
      const task = await window.agentOs.tasks.create(input)
      set((state) => ({
        tasks: byUpdatedAt([task, ...state.tasks.filter((item) => item.id !== task.id)])
      }))
      if (runNow) await get().runNow(task.id)
      return task
    } catch (error) {
      const text = message(error)
      set({ error: text })
      throw error
    }
  },
  update: async (id, patch) => {
    set({ error: null })
    try {
      const task = await window.agentOs.tasks.update(id, patch)
      if (task) {
        set((state) => ({
          tasks: byUpdatedAt(state.tasks.map((item) => (item.id === id ? task : item)))
        }))
      }
      return task
    } catch (error) {
      set({ error: message(error) })
      throw error
    }
  },
  remove: async (id) => {
    set({ error: null })
    try {
      await window.agentOs.tasks.remove(id)
      set((state) => {
        const runsByTask = { ...state.runsByTask }
        delete runsByTask[id]
        return { tasks: state.tasks.filter((task) => task.id !== id), runsByTask }
      })
    } catch (error) {
      set({ error: message(error) })
      throw error
    }
  },
  runNow: async (id) => {
    set({ error: null })
    try {
      const run = await window.agentOs.tasks.runNow(id)
      set((state) => ({
        runsByTask: {
          ...state.runsByTask,
          [id]: [run, ...(state.runsByTask[id] ?? []).filter((item) => item.id !== run.id)]
        }
      }))
      return run
    } catch (error) {
      set({ error: message(error) })
      throw error
    }
  },
  applyEvent: (event) => {
    set((state) => {
      if (event.reason === 'removed') {
        return { tasks: state.tasks.filter((task) => task.id !== event.task.id) }
      }
      const tasks = byUpdatedAt([
        event.task,
        ...state.tasks.filter((task) => task.id !== event.task.id)
      ])
      if (!event.run) return { tasks }
      return {
        tasks,
        runsByTask: {
          ...state.runsByTask,
          [event.task.id]: [
            event.run,
            ...(state.runsByTask[event.task.id] ?? []).filter((run) => run.id !== event.run?.id)
          ]
        }
      }
    })
  }
}))
