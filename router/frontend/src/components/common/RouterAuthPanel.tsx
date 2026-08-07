import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { authApi, errorMessage } from '../../api/client'
import { ErrorBanner } from './ErrorBanner'

interface AuthStatus {
  required: boolean
  source: 'env' | 'file' | 'unset'
  trustedHosts: string[]
  requestHost: string
}

// router-manager's own admin-API password setup/change - ports the inline
// JS that used to be the entire standalone /router/ page (see git history's
// handlers_ui.go) into a real component now that /router/ is this SPA.
// Distinct from RouterUnlockModalHost (UnlockModal.tsx), which only handles
// unlocking an *already-configured* gate - this is the only place that
// creates or changes the password itself.
export function RouterAuthPanel() {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await authApi.get<AuthStatus>('/status')
      setStatus(data)
      setLoadError(null)
    } catch (e) {
      setLoadError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleSetup(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await authApi.post('/setup', { password })
      setPassword('')
      setNotice('설정되었습니다.')
      await load()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleChange(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await authApi.post('/change', { currentPassword, newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setNotice('변경되었습니다.')
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (loadError) {
    return (
      <div className="card">
        <h2>router 비밀번호</h2>
        <ErrorBanner message={`상태를 불러오지 못했습니다: ${loadError}`} onDismiss={() => setLoadError(null)} />
      </div>
    )
  }

  if (!status) {
    return (
      <div className="card">
        <h2>router 비밀번호</h2>
      </div>
    )
  }

  return (
    <div className="card">
      <h2>router 비밀번호</h2>
      {notice && <p className="success-note">{notice}</p>}
      {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}

      {!status.required || status.source === 'unset' ? (
        <>
          <p className="section-description">
            아직 비밀번호가 설정되지 않았습니다. router-manager(tailscale/Dev Proxy/App
            Routes/tinyauth 관리 API)를 보호할 비밀번호를 지금 설정하세요.
          </p>
          <form onSubmit={handleSetup} className="form-grid-inline">
            <div className="form-field">
              <label htmlFor="router-auth-setup-password">새 비밀번호</label>
              <input
                id="router-auth-setup-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={submitting || !password}>
              {submitting ? '설정하는 중...' : '비밀번호 설정'}
            </button>
          </form>
        </>
      ) : status.source === 'env' ? (
        <p className="section-description">
          비밀번호가 ROUTER_MANAGER_AUTH_PASSWORD_HASH 환경변수로 고정되어 있습니다 - 여기서 바꿀 수
          없습니다.
        </p>
      ) : (
        <>
          <p className="section-description">비밀번호가 설정되어 있습니다. 바꾸려면 현재 비밀번호를 입력하세요.</p>
          <form onSubmit={handleChange} className="form-grid-inline">
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="router-auth-current-password">현재 비밀번호</label>
                <input
                  id="router-auth-current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="router-auth-new-password">새 비밀번호</label>
                <input
                  id="router-auth-new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>
            </div>
            <button type="submit" className="btn btn-primary" disabled={submitting || !currentPassword || !newPassword}>
              {submitting ? '변경하는 중...' : '비밀번호 변경'}
            </button>
          </form>
        </>
      )}
    </div>
  )
}

// Read-only display of ROUTER_MANAGER_HOSTS (router/example-env.router) -
// deliberately not an editable form. This value is nginx's own
// server_name-based routing/security boundary (see nginx.default.conf's
// NGINX_ROUTER_MANAGER_HOSTS block), same trust level as ALLOWED_HOSTS/
// ALLOWED_EXPORT_HOSTS, so unlike the password above it only takes effect
// via router/example-env.router + a container restart - this just lets a
// user confirm what's currently active without leaving the page.
export function RouterTrustedHostsPanel() {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    authApi
      .get<AuthStatus>('/status')
      .then((data) => {
        if (!cancelled) setStatus(data)
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="card">
      <h2>router-manager 전용 도메인</h2>
      <p className="section-description">
        지금 이 페이지는 <code>{status?.requestHost ?? '...'}</code>(으)로 접근되고 있습니다.
      </p>
      {loadError ? (
        <ErrorBanner message={`불러오지 못했습니다: ${loadError}`} onDismiss={() => setLoadError(null)} />
      ) : status && status.trustedHosts.length > 0 ? (
        <p className="section-description">
          설정된 전용 도메인(ROUTER_MANAGER_HOSTS): <code>{status.trustedHosts.join(', ')}</code>
        </p>
      ) : (
        <p className="section-description">
          아직 전용 도메인이 설정되어 있지 않습니다 - router/example-env.router의
          ROUTER_MANAGER_HOSTS에 도메인을 추가하고 컨테이너를 재시작하면, 이 관리 화면을
          code-server/webmanager/노출된 앱과 완전히 분리된 origin에서 쓸 수 있습니다 (docs/router.md
          참고). 값을 바꾼 뒤에는 재시작이 필요합니다 - 여기서 직접 설정할 수는 없습니다.
        </p>
      )}
    </div>
  )
}
