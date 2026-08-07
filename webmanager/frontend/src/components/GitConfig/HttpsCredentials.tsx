import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { GitCredential } from '../../api/types'
import { ErrorBanner, Skeleton } from '@code-docker/router-frontend'
import { withViewTransition } from '../../utils/viewTransition'

export function HttpsCredentials() {
  const [credentials, setCredentials] = useState<GitCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<GitCredential[]>('/git/credentials')
      setCredentials(data)
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await api.post<GitCredential>('/git/credentials', { host, username, token })
      setHost('')
      setUsername('')
      setToken('')
      await load()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(hostId: string) {
    if (!window.confirm(`"${hostId}"의 저장된 자격 증명을 삭제하시겠습니까?`)) return
    setDeleting(hostId)
    try {
      await api.del(`/git/credentials/${encodeURIComponent(hostId)}`)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="card">
      <h2>HTTPS 자격 증명</h2>
      <div className="warning-note">
        <span aria-hidden="true">⚠️</span>
        <span>
          토큰은 <code>~/.git-credentials</code>에 <strong>평문으로 저장</strong>됩니다. 컨테이너 파일시스템에
          접근 가능한 사람은 누구나 읽을 수 있으니 주의하세요.
        </span>
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <Skeleton />
      ) : credentials.length === 0 ? (
        <p className="empty-state">등록된 자격 증명이 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="git-config-table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Username</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.host}>
                  <td>{c.host}</td>
                  <td>{c.username}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deleting === c.host}
                      onClick={() => handleDelete(c.host)}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={handleSubmit} className="form-grid-inline">
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="cred-host">Host</label>
            <input id="cred-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" required />
          </div>
          <div className="form-field">
            <label htmlFor="cred-username">Username</label>
            <input
              id="cred-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="octocat"
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="cred-token">Token</label>
            <input
              id="cred-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_..."
              required
            />
          </div>
        </div>
        {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '저장하는 중...' : '자격 증명 저장'}
        </button>
      </form>
    </div>
  )
}
