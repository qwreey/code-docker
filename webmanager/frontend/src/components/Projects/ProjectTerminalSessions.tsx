import { useState } from 'react'
import { ChevronDown, ChevronRight, Terminal as TerminalIcon } from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import type { TerminalSessionInfo } from '../../api/types'
import { isUnderProjectPath } from '../../utils/projectPath'
import { withViewTransition } from '../../utils/viewTransition'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import '../common/common.css'
// Reuses ProjectMemoryPanel's section/toggle classes - same generic
// collapsed-by-default layout, not worth a third near-duplicate CSS file.
import './ProjectMemoryPanel.css'

// Self-contained "이 프로젝트에서 열린 세션" section for the Projects tab's
// per-project detail sheet - the reverse direction of Terminal's own
// "프로젝트로 이동" jump (see Terminal/TerminalHome.tsx, utils/projectPath.ts).
// Takes only a filesystem `path`, same convention as GitStatusPanel/
// ProjectMemoryPanel, and filters GET /api/terminal/sessions client-side by
// live cwd rather than adding a backend query param - the full session list
// is already small (an interactive terminal count, not thousands of rows).
// Collapsed by default and fetched lazily on first expand, like
// ProjectMemoryPanel - most projects have zero open terminal sessions.
export default function ProjectTerminalSessions({
  path,
  onOpenSession,
}: {
  path: string
  onOpenSession?: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  async function toggleOpen() {
    const next = !open
    setOpen(next)
    if (!next || loaded || loading) return

    setLoading(true)
    try {
      const res = await api.get<TerminalSessionInfo[]>('/terminal/sessions')
      setSessions(res.filter((s) => s.cwd && isUnderProjectPath(s.cwd, path)))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoaded(true)
      withViewTransition(() => setLoading(false))
    }
  }

  return (
    <section className="claude-memory-panel-section">
      <button type="button" className="claude-memory-panel-toggle" onClick={toggleOpen} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="claude-memory-panel-title">이 프로젝트에서 열린 세션</span>
      </button>

      {open && (
        <div className="claude-memory-panel-body">
          {loading ? (
            <Skeleton />
          ) : error ? (
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          ) : sessions.length === 0 ? (
            <p className="empty-state">이 프로젝트 아래에서 열린 터미널 세션이 없습니다.</p>
          ) : (
            <ul className="claude-memory-index-list">
              {sessions.map((s) => (
                <li key={s.name}>
                  <button
                    type="button"
                    className="claude-memory-index-item"
                    onClick={() => onOpenSession?.(s.name)}
                    disabled={!onOpenSession}
                  >
                    <span className="claude-memory-index-title">
                      <TerminalIcon size={13} /> {s.name}
                    </span>
                    <span className="claude-memory-index-summary mono-cell">{s.cwd}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
