import { useCallback, useEffect, useState } from 'react'
import { tinyauthApi, errorMessage } from '../../api/client'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

interface TinyauthUser {
  name: string
}

interface TinyauthUsersList {
  pinned: boolean
  users: TinyauthUser[]
}

// tinyauth (Dev Proxy exposes' opt-in forward-auth) only reads
// TINYAUTH_AUTH_USERS once at process start, so every add/delete here
// restarts the tinyauth program server-side - see
// router/backend/handlers_tinyauth.go. `pinned` mirrors
// ROUTER_MANAGER_AUTH_PASSWORD_HASH's own env-vs-file priority: a real
// TINYAUTH_AUTH_USERS env var always wins, so this UI just reports that
// instead of pretending edits here would take effect.
export function TinyauthUsers() {
  const [users, setUsers] = useState<TinyauthUser[]>([])
  const [pinned, setPinned] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await tinyauthApi.get<TinyauthUsersList>('/users')
      setUsers(data.users)
      setPinned(data.pinned)
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

  function showNotice() {
    setNotice('저장됨 (tinyauth 재시작됨)')
    setTimeout(() => setNotice(null), 2500)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await tinyauthApi.post('/users', { name, password })
      setName('')
      setPassword('')
      await load()
      showNotice()
    } catch (e) {
      setFormError(errorMessage(e))
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(userName: string) {
    if (!window.confirm(`"${userName}" 사용자를 삭제하시겠습니까?`)) return
    setDeleting(userName)
    try {
      await tinyauthApi.del(`/users/${encodeURIComponent(userName)}`)
      await load()
      showNotice()
    } catch (e) {
      await load()
      setError(errorMessage(e))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="card">
      <h2>tinyauth 사용자</h2>
      <p className="section-description">
        Dev Proxy에서 "인증 필요"로 설정한 expose에 로그인할 수 있는 계정입니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <p className="success-note">{notice}</p>}
      {pinned && (
        <ErrorBanner
          variant="warning"
          message="TINYAUTH_AUTH_USERS 환경변수로 고정되어 있습니다 - 여기서 바꿀 수 없습니다."
        />
      )}

      {loading ? (
        <Skeleton />
      ) : users.length === 0 ? (
        <p className="empty-state">등록된 사용자가 없습니다 - 등록 전까지는 아무도 로그인할 수 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="tailscale-table">
            <thead>
              <tr>
                <th>이름</th>
                {!pinned && <th aria-label="동작" />}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.name}>
                  <td>{u.name}</td>
                  {!pinned && (
                    <td>
                      <button
                        type="button"
                        className="btn btn-danger btn-small"
                        disabled={deleting === u.name}
                        onClick={() => handleDelete(u.name)}
                      >
                        삭제
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!pinned && (
        <form onSubmit={handleSubmit} className="form-grid-inline">
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="tinyauth-user-name">이름</label>
              <input id="tinyauth-user-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="form-field">
              <label htmlFor="tinyauth-user-password">비밀번호</label>
              <input
                id="tinyauth-user-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>
          {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? '추가하는 중...' : '사용자 추가'}
          </button>
        </form>
      )}
    </div>
  )
}
