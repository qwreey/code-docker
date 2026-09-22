import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, onAuthStatusChange, setUnlockPrompter } from '../../api/client'
import { ErrorBanner } from './ErrorBanner'
import { useAuthStatus } from './useAuthStatus'
import { WebAuthnUnlockButton } from './WebAuthn'
import { offerWebAuthnEnroll, webauthnUnlockAvailable } from './webauthnGate'
import './UnlockModal.css'

interface PendingUnlock {
  resolve: () => void
  reject: (reason?: unknown) => void
}

/**
 * Mounted once near the app root (see App.tsx). Registers itself as the api
 * client's global 401 handler (see setUnlockPrompter in api/client.ts): any
 * api.get/post/put/del call that gets a 401 pops this modal, and once the
 * user unlocks successfully, the client transparently re-issues the
 * original request — the caller sees it as if nothing happened. Concurrent
 * 401s share a single pending prompt instead of stacking multiple modals.
 */
export function UnlockModalHost() {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const waitersRef = useRef<PendingUnlock[]>([])
  const { status } = useAuthStatus()

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

  // Unlocked somewhere else meanwhile - another code-server extension view
  // or browser tab (the auth BroadcastChannel in api/client.ts). The cookie
  // is shared, so the waiting requests can simply go ahead; leaving the
  // prompt up would ask for a password that is no longer needed.
  useEffect(() => {
    if (!open) return
    return onAuthStatusChange(() => {
      void api
        .get<{ unlocked: boolean }>('/auth/status')
        .then((status) => {
          if (!status.unlocked || waitersRef.current.length === 0) return
          const waiters = waitersRef.current
          waitersRef.current = []
          resetForm()
          waiters.forEach((w) => w.resolve())
        })
        .catch(() => {
          // status unknown - keep the prompt up
        })
    })
  }, [open])

  function resetForm() {
    setOpen(false)
    setPassword('')
    setSubmitError(null)
    setSubmitting(false)
  }

  function finishUnlocked() {
    const waiters = waitersRef.current
    waitersRef.current = []
    resetForm()
    waiters.forEach((w) => w.resolve())
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
      await api.post<{ ok: true }>('/auth/unlock', { password })
      const typed = password
      finishUnlocked()
      offerWebAuthnEnroll(status, typed)
    } catch (err) {
      // Distinguishes a real wrong-password 401 from a 429 lockout (see
      // authgate's rate limiting) — both used to show the same generic
      // "wrong password" text, which hid the actual reason from a
      // legitimately locked-out user.
      setSubmitError(
        err instanceof ApiError && err.status === 429
          ? '시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.'
          : '비밀번호가 올바르지 않습니다',
      )
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
        <p className="section-description">이 작업을 계속하려면 비밀번호를 입력하세요.</p>
        <form onSubmit={handleSubmit} className="unlock-modal-form">
          <div className="form-field">
            <label htmlFor="unlock-modal-password">비밀번호</label>
            <input
              id="unlock-modal-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </div>
          {submitError && <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} />}
          {webauthnUnlockAvailable(status) && <WebAuthnUnlockButton onUnlocked={finishUnlocked} autoStart />}
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
