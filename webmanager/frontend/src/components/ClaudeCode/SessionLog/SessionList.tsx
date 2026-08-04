import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../../api/client'
import type { ClaudeSessionInfo, ClaudeSessionsResponse } from '../../../api/types'
import { ErrorBanner } from '../../common/ErrorBanner'
import { formatBytes } from '../../../utils/format'

function formatModifiedAt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export function SessionList({ onSelect }: { onSelect: (session: ClaudeSessionInfo) => void }) {
  const [sessions, setSessions] = useState<ClaudeSessionInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<ClaudeSessionsResponse>('/claude/sessions')
      .then((res) => {
        if (!cancelled) setSessions(res.sessions)
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <ErrorBanner message={error} onDismiss={() => setError(null)} />
  if (!sessions) return <p className="empty-state">불러오는 중...</p>
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
      {[...byProject.entries()].map(([project, projectSessions]) => (
        <div key={project} className="session-log-project-group">
          <div className="session-log-project-name">{project}</div>
          {projectSessions.map((s) => (
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
        </div>
      ))}
    </div>
  )
}
