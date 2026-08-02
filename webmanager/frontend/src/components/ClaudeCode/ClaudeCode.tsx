import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { ClaudeStatus } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { formatDurationMs } from '../../utils/format'
import '../common/common.css'
import './ClaudeCode.css'

function NotInstalled() {
  return (
    <div className="claude-ghost-wrap">
      <div className="claude-skeleton-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div className="claude-skeleton-card" key={i}>
            <div className="claude-skeleton-line claude-skeleton-line-short" />
            <div className="claude-skeleton-line" />
            <div className="claude-skeleton-line claude-skeleton-line-short" />
          </div>
        ))}
      </div>
      <div className="claude-install-overlay">
        <div className="claude-install-message">
          Claude Code가 설치되어 있지 않습니다 — <code>mise use -g claude-code</code>로 설치하거나, 이미 설치되어
          있다면 <code>WEBMANAGER_CLAUDE_BINPATH</code>를 설정하세요.
        </div>
      </div>
    </div>
  )
}

function InstalledView({ status }: { status: ClaudeStatus }) {
  const auth = status.auth ?? null
  const stats = status.stats ?? null

  return (
    <div className="claude-cards">
      <div className="claude-card">
        <div className="claude-card-label">로그인 상태</div>
        {auth?.loggedIn ? (
          <>
            <div className="claude-card-value">{auth.email}</div>
            <div className="claude-card-sub">{auth.subscriptionType} 구독</div>
          </>
        ) : (
          <div className="claude-card-note">
            터미널에서 <code>claude</code> 명령을 실행해 로그인하세요.
          </div>
        )}
      </div>

      <div className="claude-card">
        <div className="claude-card-label">총 사용량</div>
        {stats ? (
          <>
            <div className="claude-card-value">{stats.totalSessions.toLocaleString()} 세션</div>
            <div className="claude-card-sub">{stats.totalMessages.toLocaleString()} 메시지</div>
            {stats.firstSessionDate && (
              <div className="claude-card-footnote">
                {new Date(stats.firstSessionDate).toLocaleDateString()}부터 사용 중
              </div>
            )}
          </>
        ) : (
          <div className="claude-card-note">통계를 확인할 수 없습니다.</div>
        )}
      </div>

      <div className="claude-card">
        <div className="claude-card-label">오늘 / 이번 주</div>
        {stats ? (
          <>
            <div className="claude-card-value">
              오늘 {stats.today.sessionCount}세션 · {stats.today.messageCount}메시지
            </div>
            <div className="claude-card-sub">
              이번 주 {stats.week.sessionCount}세션 · {stats.week.messageCount}메시지
            </div>
          </>
        ) : (
          <div className="claude-card-note">통계를 확인할 수 없습니다.</div>
        )}
      </div>

      <div className="claude-card">
        <div className="claude-card-label">가장 긴 세션</div>
        {stats ? (
          <>
            <div className="claude-card-value">{stats.longestSessionMessageCount.toLocaleString()} 메시지</div>
            <div className="claude-card-sub">{formatDurationMs(stats.longestSessionDurationMs)}</div>
          </>
        ) : (
          <div className="claude-card-note">통계를 확인할 수 없습니다.</div>
        )}
      </div>
    </div>
  )
}

export function ClaudeCode() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const data = await api.get<ClaudeStatus>('/claude/status')
      setStatus(data)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <section>
      <div className="section-header">
        <h1>Claude Code</h1>
        <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
          {loading ? '불러오는 중...' : '새로고침'}
        </button>
      </div>
      <p className="section-description">Claude Code CLI의 로그인 상태와 사용 통계를 보여줍니다.</p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading && !status ? (
        <p className="empty-state">불러오는 중...</p>
      ) : (
        status && (status.installed ? <InstalledView status={status} /> : <NotInstalled />)
      )}
    </section>
  )
}
