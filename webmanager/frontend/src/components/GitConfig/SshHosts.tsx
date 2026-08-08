import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { GitSshHost } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { CopyButton } from '../common/CopyButton'
import { withViewTransition } from '../../utils/viewTransition'

export function SshHosts() {
  const [hosts, setHosts] = useState<GitSshHost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [host, setHost] = useState('')
  const [hostname, setHostname] = useState('')
  const [user, setUser] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [createdKey, setCreatedKey] = useState<GitSshHost | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<GitSshHost[]>('/git/ssh-hosts')
      setHosts(data)
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
      const created = await api.post<GitSshHost>('/git/ssh-hosts', { host, hostname, user })
      setCreatedKey(created)
      setHost('')
      setHostname('')
      setUser('')
      await load()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(hostId: string) {
    if (!window.confirm(`"${hostId}" 호스트 설정을 삭제하시겠습니까?`)) return
    setDeleting(hostId)
    try {
      await api.del(`/git/ssh-hosts/${encodeURIComponent(hostId)}`)
      if (createdKey?.host === hostId) setCreatedKey(null)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="card">
      <h2>SSH 키 방식 호스트</h2>
      <p className="section-description">
        <code>~/.ssh/config</code>에 호스트별로 전용 SSH 키를 등록합니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <Skeleton />
      ) : hosts.length === 0 ? (
        <p className="empty-state">등록된 호스트가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="git-config-table">
            <thead>
              <tr>
                <th>Host</th>
                <th>HostName</th>
                <th>User</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {hosts.map((h) => (
                <tr key={h.host}>
                  <td>{h.host}</td>
                  <td>{h.hostname}</td>
                  <td>{h.user}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deleting === h.host}
                      onClick={() => handleDelete(h.host)}
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

      {createdKey && (
        <div className="new-key-callout">
          <p>
            <strong>{createdKey.host}</strong> 호스트용 새 SSH 키가 생성되었습니다. 아래 공개키를 GitHub/GitLab 등
            원격 저장소에 등록하세요.
          </p>
          <div className="copyable-block">
            <code>{createdKey.publicKey}</code>
            <CopyButton text={createdKey.publicKey} />
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="form-grid-inline">
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="ssh-host">Host (별칭)</label>
            <input id="ssh-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com-work" required />
          </div>
          <div className="form-field">
            <label htmlFor="ssh-hostname">HostName</label>
            <input
              id="ssh-hostname"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="github.com"
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="ssh-user">User</label>
            <input id="ssh-user" value={user} onChange={(e) => setUser(e.target.value)} placeholder="git" required />
          </div>
        </div>
        {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '추가하는 중...' : '호스트 추가'}
        </button>
      </form>
    </div>
  )
}
