import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { OpenSession } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'
import { summarizeUserAgent } from './uaSummary'
import '../Processes/Processes.css'

const POLL_INTERVAL_MS = 30000

function formatLastSeen(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return '방금 전'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return '방금 전'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  return `${hours}시간 전`
}

// Lists code-server browser tabs currently reporting a heartbeat — pure
// visibility (see webmanager/.claude/qa-request/session-heartbeat-plan-done.md),
// not a security feature; SSO/forward-auth in front of code-docker is what
// actually controls access. GET /api/sessions is password-gated (unlike most
// reads in this app) because the list itself — which folders are open right
// now — is the sensitive part here.
export function Sessions() {
  const [sessions, setSessions] = useState<OpenSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const list = await api.get<OpenSession[]>('/sessions')
      setSessions(list)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  return (
    <section>
      <div className="section-header">
        <h1>열린 세션</h1>
      </div>
      <p className="section-description">
        지금 이 code-docker에 접속해서 30초마다 신호를 보내고 있는 code-server 브라우저 탭 목록입니다. 최근 5분
        이내 신호가 없으면 목록에서 사라지고, 30분 이상 신호가 없으면 완전히 잊혀집니다.
      </p>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <Skeleton />
      ) : sessions.length === 0 ? (
        <p className="empty-state">현재 열려있는 세션이 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="process-info-table">
            <thead>
              <tr>
                <th>폴더</th>
                <th>브라우저 / OS</th>
                <th>마지막 신호</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.folder || '알 수 없음'}</td>
                  <td title={s.userAgent}>{summarizeUserAgent(s.userAgent)}</td>
                  <td>{formatLastSeen(s.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
