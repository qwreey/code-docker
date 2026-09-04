import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { WebDavStatus } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { withViewTransition } from '../../utils/viewTransition'
import '../common/common.css'
import './FileShare.css'

// Unambiguous alphabet: no 0/O/1/l/I, since this password gets typed by hand
// into a phone's file-manager dialog at least once.
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PASSWORD_LENGTH = 24

// Rejection sampling rather than a plain modulo: the alphabet doesn't divide
// 256 evenly, so `byte % len` would make the first few characters measurably
// more likely than the rest.
function generatePassword(): string {
  const limit = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length
  let out = ''
  while (out.length < PASSWORD_LENGTH) {
    const bytes = new Uint8Array(PASSWORD_LENGTH)
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b >= limit) continue
      out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]
      if (out.length === PASSWORD_LENGTH) break
    }
  }
  return out
}

export function FileShare() {
  const [status, setStatus] = useState<WebDavStatus | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [username, setUsername] = useState('')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The plaintext of a just-set password. Held only in this component's
  // state — the server stores a hash and can never show it again, which is
  // exactly why it's rendered with a copy button and a "이 화면을 벗어나면"
  // warning rather than tucked away somewhere.
  const [newPassword, setNewPassword] = useState<string | null>(null)
  const [manualPassword, setManualPassword] = useState('')
  const [settingPassword, setSettingPassword] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  function apply(data: WebDavStatus) {
    setStatus(data)
    setEnabled(data.enabled)
    setUsername(data.username)
  }

  useEffect(() => {
    let cancelled = false
    api
      .get<WebDavStatus>('/webdav')
      .then((data) => {
        if (!cancelled) apply(data)
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) withViewTransition(() => setLoading(false))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      apply(await api.put<WebDavStatus>('/webdav', { enabled, username }))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function savePassword(password: string) {
    setSettingPassword(true)
    setError(null)
    try {
      apply(await api.put<WebDavStatus>('/webdav/password', { password }))
      setNewPassword(password || null)
      setManualPassword('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSettingPassword(false)
    }
  }

  async function handleClearPassword() {
    setConfirmClear(false)
    await savePassword('')
  }

  // Where a client should point. The share always lives at the same prefix
  // on this origin; a dedicated hostname (router vhost) serves the same path.
  const mountUrl = status ? `${window.location.origin}${status.prefix}` : ''

  return (
    <section>
      <div className="section-header">
        <h1>File share</h1>
      </div>
      <p className="section-description">
        Files 탭과 같은 폴더를 WebDAV로 내보내, 휴대폰이나 데스크톱 파일 탐색기에서 직접 마운트할 수
        있게 합니다. 기본은 꺼짐이고, 비밀번호가 없으면 켜도 아무것도 서빙하지 않습니다.
      </p>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading || !status ? (
        <Skeleton />
      ) : (
        <>
          <div className="warning-note">
            <span>
              <strong>켜기 전에 반드시 읽어주세요.</strong> WebDAV 클라이언트는 SSO 리다이렉트를 못
              탑니다. 그래서 이 경로는 바깥 리버스 프록시의 forward-auth에서 <strong>제외</strong>해야
              동작하고, 제외하는 순간 아래 비밀번호가 이 경로를 지키는 <strong>유일한</strong> 수단이
              됩니다. 경로 단위보다 호스트 단위 제외가 실수가 적으니, router vhost로 전용
              호스트네임을 주는 쪽을 권장합니다 — <code>docs/tips/webdav.md</code>.
            </span>
          </div>

          <div className="card">
            <h2>상태</h2>
            <p className={status.active ? 'success-note' : 'info-note'}>
              {status.active
                ? '공유 중입니다.'
                : status.reason || '공유가 동작하지 않습니다.'}
            </p>

            <div className="fileshare-facts">
              <div>
                <span className="fileshare-fact-label">공유 폴더</span>
                <code>{status.root}</code>
              </div>
              <div>
                <span className="fileshare-fact-label">마운트 주소</span>
                <code>{mountUrl}</code>
              </div>
              <div>
                <span className="fileshare-fact-label">사용자명</span>
                <code>{status.username}</code>
              </div>
            </div>
            <p className="section-description">
              전용 호스트네임을 쓰는 경우 주소는 <code>https://&lt;그 호스트&gt;{status.prefix}</code>
              입니다 — 경로 부분은 어느 쪽이든 같습니다.
            </p>
          </div>

          <div className="card">
            <h2>설정</h2>
            <form onSubmit={handleSubmit}>
              <label className="checkbox-option">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  disabled={status.enabledLocked}
                />
                WebDAV 공유 사용
              </label>
              {status.enabledLocked && <LockedNote name="WEBMANAGER_WEBDAV_ENABLED" />}

              <div className="form-grid">
                <div className="form-field">
                  <label htmlFor="fileshare-username">사용자명</label>
                  <input
                    id="fileshare-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={status.usernameLocked}
                    placeholder="webdav"
                  />
                </div>
              </div>
              {status.usernameLocked && <LockedNote name="WEBMANAGER_WEBDAV_USER" />}

              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving || (status.enabledLocked && status.usernameLocked)}
              >
                {saving ? '저장하는 중...' : saved ? '저장됨' : '저장'}
              </button>
            </form>
          </div>

          <div className="card">
            <h2>비밀번호</h2>
            {status.passwordLocked ? (
              <>
                <p className="section-description">
                  비밀번호가 환경변수로 고정돼 있습니다.
                </p>
                <LockedNote name="WEBMANAGER_WEBDAV_PASSWORD_HASH" />
              </>
            ) : (
              <>
                <p className="section-description">
                  서버에는 argon2id 해시만 저장되므로, 만든 비밀번호는{' '}
                  <strong>이 화면에서 딱 한 번만</strong> 볼 수 있습니다. 잊어버렸다면 새로 만드세요.
                </p>

                {newPassword && (
                  <div className="fileshare-new-password">
                    <div className="fileshare-fact-label">
                      새 비밀번호 — 지금 복사해 두세요
                    </div>
                    <div className="copyable-block">
                      <code>{newPassword}</code>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => navigator.clipboard?.writeText(newPassword)}
                    >
                      복사
                    </button>
                  </div>
                )}

                <div className="fileshare-password-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={settingPassword}
                    onClick={() => savePassword(generatePassword())}
                  >
                    {settingPassword ? '설정하는 중...' : '무작위 비밀번호 생성'}
                  </button>
                  {status.hasPassword && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={settingPassword}
                      onClick={() => setConfirmClear(true)}
                    >
                      비밀번호 삭제
                    </button>
                  )}
                </div>

                <div className="form-grid">
                  <div className="form-field">
                    <label htmlFor="fileshare-manual-password">직접 입력</label>
                    <input
                      id="fileshare-manual-password"
                      type="password"
                      value={manualPassword}
                      onChange={(e) => setManualPassword(e.target.value)}
                      placeholder="직접 정한 비밀번호"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={settingPassword || manualPassword === ''}
                  onClick={() => savePassword(manualPassword)}
                >
                  이 비밀번호로 설정
                </button>
              </>
            )}
          </div>

          <ConfirmDialog
            open={confirmClear}
            onClose={() => setConfirmClear(false)}
            onConfirm={handleClearPassword}
            title="비밀번호 삭제"
            confirmLabel="삭제"
            busy={settingPassword}
            busyLabel="삭제 중..."
          >
            <p>
              비밀번호를 지우면 공유가 즉시 멈춥니다 (켜짐 상태는 그대로 두지만, 비밀번호가 없으면
              아무것도 서빙하지 않습니다). 지금 마운트해 둔 기기들도 접근할 수 없게 됩니다.
            </p>
          </ConfirmDialog>
        </>
      )}
    </section>
  )
}

function LockedNote({ name }: { name: string }) {
  return (
    <p className="fileshare-locked-note">
      이 값은 <code>{name}</code>로 고정돼 있어 여기서 바꿀 수 없습니다. 바꾸려면 호스트에서{' '}
      <code>.env.webmanager</code>를 수정하고 컨테이너를 다시 시작하세요.
    </p>
  )
}
