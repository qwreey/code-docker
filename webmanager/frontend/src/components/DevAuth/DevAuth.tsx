import { useState, type FormEvent } from 'react'
import { api, errorMessage } from '../../api/client'
import { ErrorBanner } from '../common/ErrorBanner'

// Standalone page (no Sidebar/app shell) that Caddy's forward_auth redirects
// the browser to when a dev-proxy expose (internal/devproxy) is hit without
// a valid unlock cookie — see GET /api/auth/verify (handlers_auth.go) and
// main.tsx, which mounts this instead of <App/> when the URL matches. Reuses
// RequiresUnlock's inline password-form logic (simpler than UnlockModal's
// queue-based one, which assumes it's staying mounted inside the SPA).
function redirectTarget(): string | null {
  const rd = new URLSearchParams(window.location.search).get('rd')
  // rd always originates from our own backend (built from Caddy's
  // X-Forwarded-* on a host that already matched a dev-proxy expose), but
  // this is still a full-page navigation to attacker-influenceable input —
  // a scheme allowlist is a cheap extra layer against javascript:/data: etc.
  if (rd && (rd.startsWith('http://') || rd.startsWith('https://'))) {
    return rd
  }
  return null
}

export function DevAuth() {
  const rd = redirectTarget()
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!rd) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await api.post<{ ok: true }>('/auth/unlock', { password })
      window.location.href = rd
    } catch (err) {
      setSubmitError(errorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="requires-unlock">
      <div className="card requires-unlock-card">
        <h2>잠금 해제 필요</h2>
        <p className="section-description">
          이 dev 서버에 접근하려면 webmanager 비밀번호를 입력하세요.
        </p>
        {!rd && <ErrorBanner message="잘못된 접근입니다 - 돌아갈 주소(rd)가 없습니다." />}
        <form onSubmit={handleSubmit} className="requires-unlock-form">
          <div className="form-field">
            <label htmlFor="dev-auth-password">비밀번호</label>
            <input
              id="dev-auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
              disabled={!rd}
            />
          </div>
          {submitError && <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} />}
          <button type="submit" className="btn btn-primary" disabled={!rd || submitting || !password}>
            {submitting ? '확인 중...' : '잠금 해제'}
          </button>
        </form>
      </div>
    </div>
  )
}
