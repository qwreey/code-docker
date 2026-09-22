import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Fingerprint, Trash2 } from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import {
  declineOffer,
  defaultDeviceLabel,
  deviceEnrolled,
  enrollWebAuthn,
  forgetDeviceEnrollment,
  unlockWithWebAuthn,
  webauthnSupported,
  type WebAuthnOutcome,
} from '../../utils/webauthn'
import { registerWebAuthnHost } from './webauthnGate'
import { ConfirmDialog } from './ConfirmDialog'
import { ErrorBanner } from './ErrorBanner'
import { Sheet } from './Sheet'
import './WebAuthn.css'

// Fingerprint (WebAuthn) unlock UI - see utils/webauthn.ts and
// backend/handlers_webauthn.go. Three pieces:
//   - WebAuthnUnlockButton, inside both password forms (UnlockModal,
//     RequiresUnlock): tries once on its own when this device enrolled and
//     the click that opened the prompt still counts as user activation;
//     cancelling leaves the password field and a retry button, never a loop.
//   - an enrollment offer right after a password unlock (webauthnGate.ts's
//     offerWebAuthnEnroll)
//   - the enrolled-device list (openWebAuthnManager, from the sidebar footer)

const OUTCOME_MESSAGE: Record<Exclude<WebAuthnOutcome, 'ok'>, string> = {
  cancelled: '취소되었습니다 — 비밀번호를 입력하거나 다시 시도하세요.',
  'password-required': '마지막 비밀번호 입력 후 12시간이 지나 비밀번호가 필요합니다.',
  'rate-limited': '시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.',
  failed: '지문 잠금 해제에 실패했습니다 — 비밀번호를 입력하세요.',
}

export function WebAuthnUnlockButton({ onUnlocked, autoStart }: { onUnlocked: () => void; autoStart?: boolean }) {
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const triedRef = useRef(false)

  const attempt = useCallback(async () => {
    setWorking(true)
    setMessage(null)
    const { outcome } = await unlockWithWebAuthn()
    setWorking(false)
    if (outcome === 'ok') onUnlocked()
    else setMessage(OUTCOME_MESSAGE[outcome])
  }, [onUnlocked])

  // Once, and only with user activation still live: the prompt usually
  // opens from a click (a 401 on a button), and a browser refuses to show
  // the WebAuthn dialog without one - better not to try than to fail.
  useEffect(() => {
    if (!autoStart || triedRef.current || !deviceEnrolled()) return
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
    if (!activation?.isActive) return
    triedRef.current = true
    void attempt()
  }, [autoStart, attempt])

  return (
    <div className="webauthn-unlock">
      <button type="button" className="btn btn-secondary webauthn-unlock-btn" onClick={attempt} disabled={working}>
        <Fingerprint size={16} aria-hidden="true" />
        {working ? '확인 중...' : message ? '지문으로 다시 시도' : '지문으로 잠금 해제'}
      </button>
      {message && <p className="webauthn-unlock-message">{message}</p>}
    </div>
  )
}

// ---- host: enrollment offer + device list --------------------------------

type CredentialInfo = { id: string; label: string; rpId: string; createdAt: string; lastUsedAt?: string | null }

function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

// Mounted once, next to UnlockModalHost (App.tsx).
export function WebAuthnHost() {
  // Enrollment: the password comes from the unlock that triggered the offer,
  // or is typed in the device list's own "이 기기 등록" form.
  const [enrollPassword, setEnrollPassword] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [enrollMessage, setEnrollMessage] = useState<string | null>(null)

  const [managerOpen, setManagerOpen] = useState(false)
  const [credentials, setCredentials] = useState<CredentialInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [managerPassword, setManagerPassword] = useState('')
  const [pendingDelete, setPendingDelete] = useState<CredentialInfo | null>(null)

  const loadCredentials = useCallback(async () => {
    try {
      setCredentials(await api.get<CredentialInfo[]>('/auth/webauthn/credentials'))
      setListError(null)
    } catch (e) {
      setListError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    registerWebAuthnHost({
      offer: (password) => {
        setEnrollPassword(password)
        setLabel(defaultDeviceLabel())
        setEnrollMessage(null)
      },
      openManager: () => {
        setManagerOpen(true)
        setManagerPassword('')
        setEnrollMessage(null)
        void loadCredentials()
      },
    })
    return () => registerWebAuthnHost(null)
  }, [loadCredentials])

  async function enroll(password: string) {
    setEnrolling(true)
    setEnrollMessage(null)
    const { outcome, message } = await enrollWebAuthn(password, label || defaultDeviceLabel())
    setEnrolling(false)
    if (outcome === 'ok') {
      setEnrollPassword(null)
      setManagerPassword('')
      setEnrollMessage('이 기기가 등록되었습니다. 다음부터 지문으로 잠금을 해제할 수 있습니다.')
      if (managerOpen) void loadCredentials()
      return
    }
    setEnrollMessage(
      outcome === 'cancelled' ? '등록이 취소되었습니다.' : `등록하지 못했습니다${message ? ` (${message})` : ''}.`,
    )
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      await api.del(`/auth/webauthn/credentials/${encodeURIComponent(pendingDelete.id)}`)
      // Can't tell which entry is this browser's own, so a delete here
      // stops the automatic attempt until this device unlocks with a
      // fingerprint again (which sets the flag back).
      forgetDeviceEnrollment()
      setPendingDelete(null)
      void loadCredentials()
    } catch (e) {
      setListError(errorMessage(e))
      setPendingDelete(null)
    }
  }

  const host = window.location.hostname

  return (
    <>
      {enrollPassword !== null && (
        <div className="unlock-modal-backdrop" onClick={() => setEnrollPassword(null)}>
          <div
            className="card unlock-modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="지문 잠금 해제 등록"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>
              <Fingerprint size={18} aria-hidden="true" /> 지문으로 잠금 해제할까요?
            </h2>
            <p className="section-description">
              이 기기({host})를 등록하면 다음부터 비밀번호 대신 지문(또는 기기 PIN)으로 잠금을 해제합니다. 비밀번호는 12시간마다
              한 번은 필요합니다.
            </p>
            <div className="form-field">
              <label htmlFor="webauthn-label">기기 이름</label>
              <input id="webauthn-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
            </div>
            {enrollMessage && <p className="webauthn-unlock-message">{enrollMessage}</p>}
            <div className="unlock-modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  declineOffer()
                  setEnrollPassword(null)
                }}
              >
                다시 묻지 않기
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setEnrollPassword(null)}>
                나중에
              </button>
              <button type="button" className="btn btn-primary" disabled={enrolling} onClick={() => enroll(enrollPassword)}>
                {enrolling ? '등록 중...' : '등록'}
              </button>
            </div>
          </div>
        </div>
      )}
      {enrollPassword === null && enrollMessage && !managerOpen && (
        <div className="webauthn-toast" role="status" onClick={() => setEnrollMessage(null)}>
          {enrollMessage}
        </div>
      )}
      <Sheet open={managerOpen} onClose={() => setManagerOpen(false)} title="지문 잠금 해제">
        <p className="section-description">
          비밀번호 게이트를 지문(또는 기기 PIN)으로 푸는 기기들입니다. 기기는 등록한 주소({host} 등)에서만 쓸 수 있고, 비밀번호가
          바뀌면 모두 해제됩니다.
        </p>
        {listError && <ErrorBanner message={listError} onDismiss={() => setListError(null)} />}
        {credentials && credentials.length === 0 && <p className="empty-state">등록된 기기가 없습니다.</p>}
        {credentials && credentials.length > 0 && (
          <div className="table-wrapper">
          <table className="git-config-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>주소</th>
                <th>등록</th>
                <th>마지막 사용</th>
                <th aria-label="동작" className="table-actions-col" />
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>{c.rpId}</td>
                  <td>{formatTime(c.createdAt)}</td>
                  <td>{formatTime(c.lastUsedAt)}</td>
                  <td className="table-actions-col">
                    <button
                      type="button"
                      className="btn btn-small btn-icon"
                      title="삭제"
                      aria-label={`${c.label} 삭제`}
                      onClick={() => setPendingDelete(c)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {webauthnSupported() ? (
          <form
            className="webauthn-enroll-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              void enroll(managerPassword)
            }}
          >
            <h3>이 기기 등록</h3>
            <div className="form-field">
              <label htmlFor="webauthn-manager-label">기기 이름</label>
              <input
                id="webauthn-manager-label"
                value={label || defaultDeviceLabel()}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
              />
            </div>
            <div className="form-field">
              <label htmlFor="webauthn-manager-password">비밀번호 확인</label>
              <input
                id="webauthn-manager-password"
                type="password"
                value={managerPassword}
                onChange={(e) => setManagerPassword(e.target.value)}
                required
              />
            </div>
            {enrollMessage && <p className="webauthn-unlock-message">{enrollMessage}</p>}
            <button type="submit" className="btn btn-primary" disabled={enrolling || !managerPassword}>
              <Fingerprint size={16} aria-hidden="true" /> {enrolling ? '등록 중...' : '등록'}
            </button>
          </form>
        ) : (
          <p className="section-description">
            이 브라우저에서는 등록할 수 없습니다 — HTTPS(또는 localhost) 주소로 열어야 합니다.
          </p>
        )}
      </Sheet>
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="등록된 기기 삭제"
        confirmLabel="삭제"
        danger
      >
        <p>
          <strong>{pendingDelete?.label}</strong>({pendingDelete?.rpId})로는 더 이상 지문 잠금 해제를 할 수 없게 됩니다.
        </p>
      </ConfirmDialog>
    </>
  )
}
