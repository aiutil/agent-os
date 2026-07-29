import { create } from 'zustand'

export type NotificationTone = 'info' | 'success' | 'warning' | 'error'

export interface NotificationItem {
  id: string
  message: string
  tone: NotificationTone
  createdAt: number
  timeoutMs?: number
}

export interface NotificationInput {
  message: string
  tone?: NotificationTone
  timeoutMs?: number
}

interface NotificationState {
  items: NotificationItem[]
  show(input: NotificationInput): string
  dismiss(id: string): void
  clear(): void
}

const DEFAULT_TIMEOUT_MS = 4200
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function nextNotificationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `notice-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function clearTimer(id: string): void {
  const timer = timers.get(id)
  if (!timer) return
  clearTimeout(timer)
  timers.delete(id)
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  items: [],
  show: (input) => {
    const message = input.message.trim()
    if (!message) return ''
    const id = nextNotificationId()
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const item: NotificationItem = {
      id,
      message,
      tone: input.tone ?? 'info',
      createdAt: Date.now(),
      timeoutMs
    }

    set((state) => ({ items: [...state.items, item].slice(-4) }))

    if (timeoutMs > 0) {
      const timer = setTimeout(() => get().dismiss(id), timeoutMs)
      timers.set(id, timer)
    }
    return id
  },
  dismiss: (id) => {
    clearTimer(id)
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }))
  },
  clear: () => {
    for (const id of timers.keys()) clearTimer(id)
    set({ items: [] })
  }
}))
