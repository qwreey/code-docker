import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { TailscalePeerInfo, TailscaleStatusResponse } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

// While a login is pending, poll faster than a human would manually refresh
// so the banner clears itself once the user finishes signing in elsewhere
// (e.g. following the authUrl in another tab).
const AUTH_POLL_INTERVAL_MS = 3000

function peerIPs(peer: TailscalePeerInfo): string {
  return peer.tailscaleIPs.join(', ') || '-'
}

function peerTags(peer: TailscalePeerInfo): string {
  return peer.tags.join(', ') || '-'
}

export function Status() {
  const [data, setData] = useState<TailscaleStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<TailscaleStatusResponse>('/tailscale/status')
      setData(res)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const status = data?.status
  // needsLogin covers both "an auth attempt is already pending" (authUrl
  // set) and "not logged in, nothing pending yet" - the latter is now the
  // common case, since tailscale-service.default.sh's automatic `tailscale
  // up` only fires once ever (see its LOGIN_ATTEMPTED_MARKER), not on every
  // restart. The login-trigger button below only makes sense for the second
  // case; once authUrl appears, this just falls back to the plain link.
  const needsLogin = Boolean(data?.available && status && status.backendState !== 'Running')
  const authPending = needsLogin && Boolean(status?.authUrl)

  // Separate effect (rather than folding into the initial-load effect) so it
  // starts/stops purely based on the derived needsLogin flag - it naturally
  // stops polling the moment a refresh (manual or interval-driven) reports
  // the login as resolved.
  useEffect(() => {
    if (!needsLogin) return
    const timer = setInterval(load, AUTH_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [needsLogin, load])

  const handleStartLogin = useCallback(async () => {
    if (starting) return
    setStarting(true)
    try {
      await api.post('/tailscale/login/start')
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStarting(false)
    }
  }, [starting, load])

  return (
    <div className="card">
      <div className="section-header">
        <h2>상태</h2>
        <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
          {loading ? '불러오는 중...' : '새로고침'}
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading && !data ? (
        <Skeleton />
      ) : !data ? null : !data.available ? (
        <p className="tailscale-status-note">tailscale 상태를 확인할 수 없습니다 (설치/실행 여부 확인 필요)</p>
      ) : needsLogin && status ? (
        <ErrorBanner
          variant="warning"
          message={
            <span>
              <strong>Tailscale 로그인이 필요합니다</strong> (상태: {status.backendState})
              <br />
              {authPending ? (
                <a
                  href={status.authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary btn-small tailscale-login-link"
                >
                  로그인하러 가기
                </a>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={handleStartLogin}
                  disabled={starting}
                >
                  {starting ? '시도하는 중...' : '로그인 시도하기'}
                </button>
              )}
            </span>
          }
        />
      ) : status ? (
        <>
          <div className="tailscale-status-grid">
            <div className="card">
              <h2>내 정보</h2>
              {status.self ? (
                <dl className="tailscale-info-list">
                  <div>
                    <dt>호스트명</dt>
                    <dd>{status.self.hostName}</dd>
                  </div>
                  <div>
                    <dt>IP</dt>
                    <dd>{peerIPs(status.self)}</dd>
                  </div>
                  <div>
                    <dt>릴레이/지역</dt>
                    <dd>{status.self.relay || '-'}</dd>
                  </div>
                  <div>
                    <dt>Tailnet</dt>
                    <dd>{status.tailnetName || '-'}</dd>
                  </div>
                </dl>
              ) : (
                <p className="empty-state">내 정보를 확인할 수 없습니다.</p>
              )}
            </div>

            <div className="card">
              <h2>피어 목록</h2>
              {status.peers.length === 0 ? (
                <p className="empty-state">연결된 피어가 없습니다.</p>
              ) : (
                <div className="table-wrapper">
                  <table className="tailscale-table">
                    <thead>
                      <tr>
                        <th>호스트명</th>
                        <th>IP</th>
                        <th>릴레이</th>
                        <th>상태</th>
                        <th>태그</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.peers.map((peer) => (
                        <tr key={peer.dnsName || peer.hostName}>
                          <td>{peer.hostName}</td>
                          <td className="mono-cell">{peerIPs(peer)}</td>
                          <td>{peer.relay || '-'}</td>
                          <td>
                            <span className={`badge ${peer.online ? 'badge-green' : 'badge-gray'}`}>
                              {peer.online ? '온라인' : '오프라인'}
                            </span>
                          </td>
                          <td>{peerTags(peer)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <p className="tailscale-status-disclaimer">
            ACL 정책 자체는 여기서 조회할 수 없습니다 — 위 피어/태그 목록으로 접근 범위가 예상과 맞는지 육안으로
            확인하는 용도입니다.
          </p>
        </>
      ) : null}
    </div>
  )
}
