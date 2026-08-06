import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { authApi, setUnlockPrompter } from '../../api/client'
import { ErrorBanner } from './ErrorBanner'
import './UnlockModal.css'

interface PendingUnlock {
  resolve: () => void
  reject: (reason?: unknown) => void
}

/**
 * router-manager's own password gate (internal/authgate, opt-in via
 * ROUTER_MANAGER_AUTH_PASSWORD_HASH - see router/plan.md). Mount once near
 * the consuming app's root (webmanager's App.tsx mounts this next to its
 * own UnlockModalHost) - registers itself as every createApiClient(prefix)
 * instance's global 401 handler (see setUnlockPrompter in api/client.ts):
 * any api.post/put/del call against a gated router-manager route that gets
 * a 401 pops this modal, and once unlocked, the client transparently
 * re-issues the original request. Concurrent 401s share a single pending
 * prompt instead of stacking multiple modals. If the gate isn't configured
 * at all, router-manager never returns a 401 here and this never renders.
 */
export function RouterUnlockModalHost() {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const waitersRef = useRef<PendingUnlock[]>([])

  const prompt = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      waitersRef.current.push({ resolve, reject })
      setOpen(true)
    })
  }, [])

  useEffect(() => {
    setUnlockPrompter(prompt)
    return () => setUnlockPrompter(null)
  }, [prompt])

  function resetForm() {
    setOpen(false)
    setPassword('')
    setSubmitError(null)
    setSubmitting(false)
  }

  function handleCancel() {
    const waiters = waitersRef.current
    waitersRef.current = []
    resetForm()
    waiters.forEach((w) => w.reject(new Error('잠금 해제가 취소되었습니다')))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setSubmitError(null)
    try {
      await authApi.post<{ ok: true }>('/unlock', { password })
      const waiters = waitersRef.current
      waitersRef.current = []
      resetForm()
      waiters.forEach((w) => w.resolve())
    } catch {
      setSubmitError('비밀번호가 올바르지 않습니다')
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="unlock-modal-backdrop" onClick={handleCancel}>
      <div
        className="card unlock-modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="잠금 해제 필요"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>잠금 해제 필요</h2>
        <p className="section-description">이 작업을 계속하려면 router 비밀번호를 입력하세요.</p>
        <form onSubmit={handleSubmit} className="unlock-modal-form">
          <div className="form-field">
            <label htmlFor="router-unlock-modal-password">비밀번호</label>
            <input
              id="router-unlock-modal-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </div>
          {submitError && <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} />}
          <div className="unlock-modal-actions">
            <button type="button" className="btn btn-secondary" onClick={handleCancel}>
              취소
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting || !password}>
              {submitting ? '확인 중...' : '잠금 해제'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
