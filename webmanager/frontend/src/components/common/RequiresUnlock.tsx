import { useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError } from '../../api/client'
import { ErrorBanner } from './ErrorBanner'
import { Skeleton } from './Skeleton'
import { useAuthStatus } from './useAuthStatus'
import './RequiresUnlock.css'

/**
 * Generic password-gate wrapper: checks GET /auth/status on mount and either
 * renders children directly (no password configured, or already unlocked
 * via a valid cookie) or renders an inline unlock form that must succeed
 * before children mount. Not coupled to any specific feature — file manager
 * is the first consumer, terminal is expected to reuse this unchanged later.
 */
export function RequiresUnlock({ children }: { children: ReactNode }) {
  const { status, error: loadError, refresh } = useAuthStatus()
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setSubmitError(null)
    try {
      await api.post<{ ok: true }>('/auth/unlock', { password })
      await refresh()
      setPassword('')
    } catch (err) {
      setSubmitError(
        err instanceof ApiError && err.status === 429
          ? '시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.'
          : '비밀번호가 올바르지 않습니다',
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (loadError) {
    return <ErrorBanner message={loadError} onDismiss={refresh} />
  }

  if (!status) {
    return <Skeleton />
  }

  if (!status.required || status.unlocked) {
    return <>{children}</>
  }

  return (
    <div className="requires-unlock">
      <div className="card requires-unlock-card">
        <h2>잠금 해제 필요</h2>
        <p className="section-description">이 기능을 사용하려면 비밀번호를 입력하세요.</p>
        <form onSubmit={handleSubmit} className="requires-unlock-form">
          <div className="form-field">
            <label htmlFor="unlock-password">비밀번호</label>
            <input
              id="unlock-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </div>
          {submitError && <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} />}
          <button type="submit" className="btn btn-primary" disabled={submitting || !password}>
            {submitting ? '확인 중...' : '잠금 해제'}
          </button>
        </form>
      </div>
    </div>
  )
}
