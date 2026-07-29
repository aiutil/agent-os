import { describe, expect, it } from 'vitest'
import {
  buildRemoteWorkspaceChoices,
  nextWorkspaceMenuStateAfterAddProject
} from '../src/shared/workspace-selector-behavior'

describe('workspace selector browse behavior', () => {
  it('keeps the menu open while async remote browsing updates workspace options', () => {
    expect(nextWorkspaceMenuStateAfterAddProject({ asyncBrowse: true })).toEqual({
      open: true,
      clearQuery: false
    })
  })

  it('closes immediately for the local add-project dialog path', () => {
    expect(nextWorkspaceMenuStateAfterAddProject({ asyncBrowse: false })).toEqual({
      open: false,
      clearQuery: true
    })
  })

  it('uses only confirmed remote listing paths once remote browsing has loaded', () => {
    const choices = buildRemoteWorkspaceChoices({
      selectedPath: '/Users/tester/upwork/agent-os',
      recentPaths: ['/Users/tester/upwork/agent-os'],
      sessionPaths: ['/Users/tester/upwork/agent-os'],
      listing: {
        hostId: 'node-1',
        home: '/root',
        parent: '/',
        path: '/root',
        entries: [
          { path: '/root/work', hidden: false },
          { path: '/root/.cache', hidden: true }
        ]
      }
    })

    expect(choices.paths).toEqual(['/root'])
    expect(choices.workspacePath).toBe('/root')
  })
})
