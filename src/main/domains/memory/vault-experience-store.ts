import type {
  CreateExperienceInput,
  ExperienceEntry,
  UpdateExperiencePatch
} from '@shared/types'
import { MemoryVault } from './vault'

/**
 * 兼容旧 experience IPC 的薄适配层。历史 UI 仍可工作，但数据已经写入长期记忆 Vault，
 * 不再维护第二份 electron-store 真源。
 */
export class VaultExperienceStore {
  constructor(private readonly vault: MemoryVault) {}

  list(query = ''): ExperienceEntry[] {
    return this.vault
      .list({ query, statuses: ['active'], limit: 500 })
      .map((memory) => ({
        id: memory.id,
        title: memory.title,
        contentMd: memory.content,
        ...(memory.evidence.find((item) => item.sourceType === 'session')
          ? { sourceSessionId: memory.evidence.find((item) => item.sourceType === 'session')!.sourceId }
          : {}),
        tags: memory.tags,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt
      }))
  }

  create(input: CreateExperienceInput): ExperienceEntry {
    const candidate = this.vault.propose({
      kind: 'knowledge',
      title: input.title,
      content: input.contentMd,
      scope: 'user',
      confidence: 'confirmed',
      tags: input.tags,
      evidence: input.sourceSessionId
        ? [{ sourceType: 'session', sourceId: input.sourceSessionId }]
        : [{ sourceType: 'manual', sourceId: 'experience-ui' }]
    })
    const memory = this.vault.confirm(candidate.id)!
    return {
      id: memory.id,
      title: memory.title,
      contentMd: memory.content,
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.toolId ? { toolId: input.toolId } : {}),
      tags: memory.tags,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt
    }
  }

  update(id: string, patch: UpdateExperiencePatch): ExperienceEntry | null {
    const memory = this.vault.update(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.contentMd !== undefined ? { content: patch.contentMd } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {})
    })
    if (!memory) return null
    return {
      id: memory.id,
      title: memory.title,
      contentMd: memory.content,
      tags: memory.tags,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt
    }
  }

  remove(id: string): void {
    this.vault.forget(id)
  }
}
