import { randomUUID } from 'node:crypto'
import type {
  CreateExperienceInput,
  ExperienceEntry,
  UpdateExperiencePatch
} from '@shared/types'

export interface ExperiencePersistence {
  getEntries(): ExperienceEntry[]
  setEntries(entries: ExperienceEntry[]): void
}

export class ExperienceStore {
  constructor(private readonly persistence: ExperiencePersistence) {}

  list(query = ''): ExperienceEntry[] {
    const normalized = query.trim().toLocaleLowerCase()
    return this.persistence
      .getEntries()
      .filter((entry) => {
        if (!normalized) return true
        return [entry.title, entry.contentMd, ...entry.tags]
          .join('\n')
          .toLocaleLowerCase()
          .includes(normalized)
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  create(input: CreateExperienceInput): ExperienceEntry {
    const now = new Date().toISOString()
    const entry: ExperienceEntry = {
      id: randomUUID(),
      title: input.title.trim() || '未命名经验',
      contentMd: input.contentMd.trim(),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.toolId ? { toolId: input.toolId } : {}),
      tags: input.tags.map((tag) => tag.trim()).filter(Boolean),
      createdAt: now,
      updatedAt: now
    }
    this.persistence.setEntries([entry, ...this.persistence.getEntries()])
    return entry
  }

  update(id: string, patch: UpdateExperiencePatch): ExperienceEntry | null {
    const entries = this.persistence.getEntries()
    const index = entries.findIndex((entry) => entry.id === id)
    if (index === -1) return null
    const current = entries[index]
    const updated: ExperienceEntry = {
      ...current,
      ...(patch.title !== undefined
        ? { title: patch.title.trim() || current.title }
        : {}),
      ...(patch.contentMd !== undefined
        ? { contentMd: patch.contentMd.trim() }
        : {}),
      ...(patch.tags !== undefined
        ? { tags: patch.tags.map((tag) => tag.trim()).filter(Boolean) }
        : {}),
      updatedAt: new Date().toISOString()
    }
    entries[index] = updated
    this.persistence.setEntries(entries)
    return updated
  }

  remove(id: string): void {
    this.persistence.setEntries(
      this.persistence.getEntries().filter((entry) => entry.id !== id)
    )
  }
}
