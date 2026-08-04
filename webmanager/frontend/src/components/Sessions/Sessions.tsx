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
  // In-flight close requests only - purely for disabling the button while the
  // POST is outstanding. The requested/not-requested state itself always
  // comes from the server's closeRequested field (via the next load()), so
  // this never has to be reconciled against it.
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set())

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

  const requestClose = useCallback(
    async (id: string) => {
      setClosingIds((prev) => new Set(prev).add(id))
      try {
        await api.post(`/sessions/${id}/close`, {})
        await load()
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        setClosingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    },
    [load],
  )

  return (
    <section>
      <div className="section-header">
        <h1>열린 세션</h1>
      </div>
      <p className="section-description">
        지금 이 code-docker에 접속해서 30초마다 신호를 보내고 있는 code-server 브라우저 탭 목록입니다. 최근 5분
        이내 신호가 없으면 목록에서 사라지고, 30분 이상 신호가 없으면 완전히 잊혀집니다.
        <br />* 닫기는 강제적 세션 삭제 기능이 아닙니다. 브라우저에 닫는 요청을 날리는 기능으로 편의 기능일 뿐, 보안
        도구가 아닙니다
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
                <th>동작</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.folder || '알 수 없음'}</td>
                  <td title={s.userAgent}>{summarizeUserAgent(s.userAgent)}</td>
                  <td>{formatLastSeen(s.lastSeen)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={s.closeRequested || closingIds.has(s.id)}
                      onClick={() => requestClose(s.id)}
                    >
                      {s.closeRequested ? '닫기 요청됨' : '닫기 시도'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
