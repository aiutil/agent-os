import { describe, expect, it } from 'vitest'
import {
  activateWorkspaceTab,
  closeWorkspaceTabs,
  closeWorkspaceTab,
  cycleWorkspaceTabId,
  openOrFocusWorkspaceTab,
  pruneWorkspaceTabs,
  reorderWorkspaceTab,
  restoreWorkspaceTabs,
  setWorkspaceTabPinned,
  syncWorkspaceSessionTabTitles,
  workspaceTabIdsForCloseMode,
  workspaceTabIdAtIndex,
  type WorkspaceTabsSnapshot
} from '../src/shared/workspace-tabs'

const empty: WorkspaceTabsSnapshot = { tabs: [], activeTabId: null }

describe('workspace tabs model', () => {
  it('deduplicates the same resource and refreshes its metadata', () => {
    const opened = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'Old', toolId: 'claude' },
      10
    )
    const focused = openOrFocusWorkspaceTab(
      opened,
      { kind: 'session', resourceId: 's1', title: 'New', toolId: 'codex' },
      20
    )

    expect(focused.tabs).toHaveLength(1)
    expect(focused.tabs[0]).toMatchObject({
      id: 'session:s1',
      title: 'New',
      toolId: 'codex',
      openedAt: 10,
      lastActiveAt: 20
    })
    expect(focused.activeTabId).toBe('session:s1')
  })

  it('syncs session titles without activating or reordering tabs', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: '旧标题' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      20
    )

    const synced = syncWorkspaceSessionTabTitles(state, { s1: '真实任务标题' })

    expect(synced.tabs.map((tab) => [tab.id, tab.title])).toEqual([
      ['session:s1', '真实任务标题'],
      ['memory:m1', 'Memory']
    ])
    expect(synced.activeTabId).toBe('memory:m1')
    expect(synced.tabs[0].lastActiveAt).toBe(10)
  })

  it('falls back to the most recently used remaining tab', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'compare', resourceId: 'c1', title: 'Compare' },
      20
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      30
    )
    state = activateWorkspaceTab(state, 'session:s1', 40)
    state = activateWorkspaceTab(state, 'memory:m1', 50)

    const closed = closeWorkspaceTab(state, 'memory:m1')
    expect(closed.activeTabId).toBe('session:s1')
  })

  it('keeps the active tab when closing an inactive tab', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'compare', resourceId: 'c1', title: 'Compare' },
      20
    )
    const closed = closeWorkspaceTab(state, 'session:s1')
    expect(closed.activeTabId).toBe('compare:c1')
  })

  it('cycles in visual order and wraps in both directions', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'compare', resourceId: 'c1', title: 'Compare' },
      20
    )

    expect(cycleWorkspaceTabId(state.tabs, 'compare:c1', 1)).toBe('session:s1')
    expect(cycleWorkspaceTabId(state.tabs, 'session:s1', -1)).toBe('compare:c1')
  })

  it('maps command-number shortcuts to one-based positions', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      20
    )

    expect(workspaceTabIdAtIndex(state.tabs, 1)).toBe('session:s1')
    expect(workspaceTabIdAtIndex(state.tabs, 2)).toBe('memory:m1')
    expect(workspaceTabIdAtIndex(state.tabs, 3)).toBeNull()
  })

  it('pins tabs to the left while preserving shortcut visual order', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      20
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'compare', resourceId: 'c1', title: 'Compare' },
      30
    )

    state = setWorkspaceTabPinned(state, 'compare:c1', true)

    expect(state.tabs.map((tab) => tab.id)).toEqual(['compare:c1', 'session:s1', 'memory:m1'])
    expect(workspaceTabIdAtIndex(state.tabs, 1)).toBe('compare:c1')

    state = setWorkspaceTabPinned(state, 'compare:c1', false)

    expect(state.tabs.map((tab) => tab.id)).toEqual(['compare:c1', 'session:s1', 'memory:m1'])
    expect(state.tabs[0].pinned).toBe(false)
  })

  it('keeps pinned tabs when bulk closing unpinned tabs', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      20
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'compare', resourceId: 'c1', title: 'Compare' },
      30
    )
    state = setWorkspaceTabPinned(state, 'memory:m1', true)
    state = activateWorkspaceTab(state, 'compare:c1', 40)

    const closeIds = workspaceTabIdsForCloseMode(state.tabs, 'compare:c1', 'all')
    expect(closeIds).toEqual(['session:s1', 'compare:c1'])

    const closed = closeWorkspaceTabs(state, closeIds)
    expect(closed.tabs.map((tab) => tab.id)).toEqual(['memory:m1'])
    expect(closed.activeTabId).toBe('memory:m1')
  })

  it('protects pinned tabs for close others and side ranges', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      20
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'compare', resourceId: 'c1', title: 'Compare' },
      30
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'web', resourceId: 'w1', title: 'Web' },
      40
    )
    state = setWorkspaceTabPinned(state, 'memory:m1', true)

    expect(workspaceTabIdsForCloseMode(state.tabs, 'compare:c1', 'others')).toEqual([
      'session:s1',
      'web:w1'
    ])
    expect(workspaceTabIdsForCloseMode(state.tabs, 'compare:c1', 'left')).toEqual([
      'session:s1'
    ])
    expect(workspaceTabIdsForCloseMode(state.tabs, 'compare:c1', 'right')).toEqual(['web:w1'])
  })

  it('reorders unpinned tabs within the normal group', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      20
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'compare', resourceId: 'c1', title: 'Compare' },
      30
    )

    const reordered = reorderWorkspaceTab(state, 'compare:c1', 'session:s1')

    expect(reordered.tabs.map((tab) => tab.id)).toEqual(['compare:c1', 'session:s1', 'memory:m1'])
    expect(workspaceTabIdAtIndex(reordered.tabs, 1)).toBe('compare:c1')
  })

  it('reorders pinned tabs but keeps them before normal tabs', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      20
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'compare', resourceId: 'c1', title: 'Compare' },
      30
    )
    state = setWorkspaceTabPinned(state, 'memory:m1', true)
    state = setWorkspaceTabPinned(state, 'compare:c1', true)

    const reordered = reorderWorkspaceTab(state, 'compare:c1', 'memory:m1')

    expect(reordered.tabs.map((tab) => tab.id)).toEqual(['compare:c1', 'memory:m1', 'session:s1'])
  })

  it('does not reorder across pinned and normal groups', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      20
    )
    state = setWorkspaceTabPinned(state, 'memory:m1', true)

    const reordered = reorderWorkspaceTab(state, 'session:s1', 'memory:m1')

    expect(reordered.tabs.map((tab) => tab.id)).toEqual(['memory:m1', 'session:s1'])
  })

  it('removes invalid sessions and comparisons but keeps lazy memory tabs', () => {
    let state = openOrFocusWorkspaceTab(
      empty,
      { kind: 'session', resourceId: 's1', title: 'One' },
      10
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'compare', resourceId: 'c1', title: 'Compare' },
      20
    )
    state = openOrFocusWorkspaceTab(
      state,
      { kind: 'memory', resourceId: 'm1', title: 'Memory' },
      30
    )

    const pruned = pruneWorkspaceTabs(state, new Set(), new Set())
    expect(pruned.tabs.map((tab) => tab.id)).toEqual(['memory:m1'])
    expect(pruned.activeTabId).toBe('memory:m1')
  })

  it('recovers safely from malformed or duplicate persisted data', () => {
    expect(restoreWorkspaceTabs({ tabs: 'broken', activeTabId: 42 })).toEqual(empty)

    const restored = restoreWorkspaceTabs({
      tabs: [
        {
          id: 'session:s1',
          kind: 'session',
          resourceId: 's1',
          title: 'One',
          pinned: true,
          openedAt: 1,
          lastActiveAt: 2
        },
        {
          id: 'session:s1',
          kind: 'session',
          resourceId: 's1',
          title: 'Duplicate',
          openedAt: 3,
          lastActiveAt: 4
        },
        { id: 'wrong', kind: 'memory', resourceId: 'm1', title: 'Wrong id' }
      ],
      activeTabId: 'missing'
    })

    expect(restored.tabs).toHaveLength(1)
    expect(restored.tabs[0].title).toBe('One')
    expect(restored.tabs[0].pinned).toBe(true)
    expect(restored.activeTabId).toBeNull()
  })
})
