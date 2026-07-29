import { useRef, useState } from 'react'
import type { StatsProjectOption } from '@shared/types'
import { filterStatsProjects, projectBasename } from '@shared/stats-project-filter'
import { useT } from '../../../lib/i18n'
import { PortalMenu } from '../../shared/PortalMenu'

const SearchIcon = (): React.JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
    <circle cx="5.5" cy="5.5" r="3.75" stroke="currentColor" strokeWidth="1.2" />
    <path d="m8.4 8.4 2.6 2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

export function StatsProjectFilter({
  value,
  projects,
  onChange
}: {
  value: string
  projects: StatsProjectOption[]
  onChange(value: string): void
}): React.JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const selected = projects.find((project) => project.key === value)
  const selectedPath = selected?.key ?? value
  const selectedLabel = value
    ? projectBasename(selected?.label || selectedPath)
    : t('stats.view.projectAll')
  const filteredProjects = filterStatsProjects(projects, query)

  const closeMenu = (): void => {
    setOpen(false)
    setQuery('')
  }

  const selectProject = (key: string): void => {
    onChange(key)
    closeMenu()
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value ? selectedPath : t('stats.view.projectAll')}
        onClick={() => {
          if (open) closeMenu()
          else setOpen(true)
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          minWidth: 120,
          maxWidth: 220,
          padding: '0 10px',
          borderRadius: 7,
          border: 'none',
          background: open ? 'var(--bg-active)' : 'var(--bg-panel)',
          fontSize: 11.5,
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          font: 'inherit'
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {selectedLabel}
        </span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          style={{
            opacity: 0.5,
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 160ms'
          }}
        >
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <PortalMenu
        anchorRef={buttonRef}
        open={open}
        onClose={closeMenu}
        width={380}
        align="right"
        animateEnter
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            borderBottom: '1px solid var(--border-subtle)',
            color: 'var(--text-muted)'
          }}
        >
          <SearchIcon />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('stats.view.projectSearchPlaceholder')}
            aria-label={t('stats.view.projectSearchPlaceholder')}
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              font: 'inherit',
              fontSize: 12,
              color: 'var(--text-primary)'
            }}
          />
        </div>

        <div role="listbox" aria-label={t('stats.view.projectAll')}>
          <button
            type="button"
            role="option"
            aria-selected={!value}
            onClick={() => selectProject('')}
            style={{
              width: '100%',
              padding: '8px 10px',
              border: 'none',
              borderRadius: 6,
              background: value ? 'transparent' : 'var(--bg-active)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              textAlign: 'left'
            }}
          >
            {t('stats.view.projectAll')}
          </button>

          <div style={{ height: 1, margin: '3px 6px', background: 'var(--border-subtle)' }} />

          <div style={{ maxHeight: 276, overflowY: 'auto', scrollbarWidth: 'thin' }}>
            {filteredProjects.map((project) => {
              const active = project.key === value
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  key={project.key}
                  onClick={() => selectProject(project.key)}
                  style={{
                    width: '100%',
                    display: 'block',
                    padding: '8px 10px',
                    border: 'none',
                    borderRadius: 6,
                    background: active ? 'var(--bg-active)' : 'transparent',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    font: 'inherit',
                    textAlign: 'left'
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      marginBottom: 3,
                      fontSize: 12,
                      fontWeight: 600,
                      lineHeight: 1.25
                    }}
                  >
                    {projectBasename(project.label || project.key)}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      lineHeight: 1.4,
                      color: 'var(--text-muted)',
                      whiteSpace: 'normal',
                      overflowWrap: 'anywhere',
                      userSelect: 'text'
                    }}
                  >
                    {project.key}
                  </span>
                </button>
              )
            })}
            {filteredProjects.length === 0 && (
              <div
                style={{
                  padding: '18px 10px',
                  color: 'var(--text-muted)',
                  fontSize: 12,
                  textAlign: 'center'
                }}
              >
                {t('stats.view.projectNotFound')}
              </div>
            )}
          </div>
        </div>
      </PortalMenu>
    </>
  )
}
