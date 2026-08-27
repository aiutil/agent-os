import { describe, expect, it } from 'vitest'
import { migrateDefaultAgentOsBookmark } from '../src/shared/web-bookmark'

describe('default Agent OS bookmark migration', () => {
  it('updates the former Agent Life default without overwriting user edits', () => {
    expect(
      migrateDefaultAgentOsBookmark({
        id: 'bm-agent-life',
        name: 'Agent Life',
        url: 'https://agentos.aiutil.com/',
        color: '#8b5cf6',
        pinned: true
      })
    ).toMatchObject({ name: 'Agent OS', url: 'https://agentos.aiutil.com' })

    expect(
      migrateDefaultAgentOsBookmark({
        id: 'bm-agent-life',
        name: 'My home',
        url: 'https://example.com',
        color: '#8b5cf6',
        pinned: true
      })
    ).toMatchObject({ name: 'My home', url: 'https://example.com' })
  })
})
