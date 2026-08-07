import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../../api/client'
import type { ClaudeSessionInfo, ClaudeSessionsResponse } from '../../../api/types'
import { ErrorBanner, Skeleton } from '@code-docker/router-frontend'
import { formatBytes } from '../../../utils/format'
import { withViewTransition } from '../../../utils/viewTransition'

// Client-side-only UI preference (collapse state) - see webmanager/CLAUDE.md's
// "Client-side-only UI preferences" ground rule: per-browser localStorage,
// no backend persistence, same try/catch-wrapped pattern as Extensions.tsx.
const COLLAPSED_KEY = 'webmanager.claudeSessionLog.collapsedProjects'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function saveCollapsed(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    // localStorage unavailable (e.g. private browsing) - preference just won't persist
  }
}

// How many sessions each project group shows before "더 보기" - GET
// /api/claude/sessions has no limit/offset (see internal/claudecode/
// sessions.go's ListSessions), it always returns every session found on
// disk. Rather than add backend pagination for what's still a modest amount
// of data, groups just render a capped slice client-side and expand on
// demand - the least invasive fix, per session-log-plan's existing
// per-file/per-line degrade-gracefully spirit.
const INITIAL_VISIBLE = 8
const VISIBLE_STEP = 12

function formatModifiedAt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export function SessionList({ onSelect }: { onSelect: (session: ClaudeSessionInfo) => void }) {
  const [sessions, setSessions] = useState<ClaudeSessionInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed())
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    let cancelled = false
    api
      .get<ClaudeSessionsResponse>('/claude/sessions')
      .then((res) => {
        if (!cancelled) withViewTransition(() => setSessions(res.sessions))
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function toggleCollapsed(project: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      saveCollapsed(next)
      return next
    })
  }

  function showMore(project: string) {
    setVisibleCounts((prev) => ({ ...prev, [project]: (prev[project] ?? INITIAL_VISIBLE) + VISIBLE_STEP }))
  }

  if (error) return <ErrorBanner message={error} onDismiss={() => setError(null)} />
  if (!sessions) return <Skeleton />
  if (sessions.length === 0) return <p className="empty-state">대화 로그가 없습니다.</p>

  const byProject = new Map<string, ClaudeSessionInfo[]>()
  for (const s of sessions) {
    const key = s.cwd || s.project
    const list = byProject.get(key) ?? []
    list.push(s)
    byProject.set(key, list)
  }

  return (
    <div className="session-log-list">
      {[...byProject.entries()].map(([project, projectSessions]) => {
        const isOpen = !collapsed.has(project)
        const visibleCount = visibleCounts[project] ?? INITIAL_VISIBLE
        const visibleSessions = projectSessions.slice(0, visibleCount)
        const remaining = projectSessions.length - visibleSessions.length

        return (
          <div key={project} className="session-log-project-group">
            <button
              type="button"
              className="session-log-project-toggle"
              onClick={() => toggleCollapsed(project)}
              aria-expanded={isOpen}
            >
              <span className={`session-log-chevron${isOpen ? ' session-log-chevron-open' : ''}`}>▶</span>
              <span className="session-log-project-name">{project}</span>
              <span className="session-log-project-count">{projectSessions.length}</span>
            </button>
            {isOpen && (
              <div className="session-log-project-body">
                {visibleSessions.map((s) => (
                  <button
                    type="button"
                    key={`${s.project}/${s.sessionId}`}
                    className="session-log-session-card"
                    onClick={() => onSelect(s)}
                  >
                    <div className="session-log-session-preview">{s.preview || '(내용 없음)'}</div>
                    <div className="session-log-session-meta">
                      {formatModifiedAt(s.modifiedAt)} · {formatBytes(s.sizeBytes)}
                    </div>
                  </button>
                ))}
                {remaining > 0 && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small session-log-more-btn"
                    onClick={() => showMore(project)}
                  >
                    더 보기 ({remaining}개 더)
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
