import Store from 'electron-store'
import type { ExperienceEntry } from '@shared/types'
import {
  ExperienceStore,
  type ExperiencePersistence
} from './experience-store'

interface ExperienceSchema {
  entries: ExperienceEntry[]
}

export function createExperienceStore(cwd: string): ExperienceStore {
  const store = new Store<ExperienceSchema>({
    name: 'agent-os-experiences',
    cwd,
    defaults: { entries: [] }
  })
  const persistence: ExperiencePersistence = {
    getEntries: () => store.get('entries'),
    setEntries: (entries) => store.set('entries', entries)
  }
  return new ExperienceStore(persistence)
}
