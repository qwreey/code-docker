import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { KnownHostEntry } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

export function KnownHosts() {
  const [entries, setEntries] = useState<KnownHostEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [line, setLine] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<KnownHostEntry[]>('/git/known-hosts')
      setEntries(data)
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
      await api.post('/git/known-hosts', { line })
      setLine('')
      await load()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(index: number, host: string) {
    if (!window.confirm(`"${host}" known_hosts 항목을 삭제하시겠습니까?`)) return
    setDeleting(index)
    try {
      await api.del(`/git/known-hosts/${index}`)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="card">
      <h2>SSH known_hosts</h2>
      <p className="section-description">
        Git 원격 서버의 신뢰된 호스트 키 목록입니다. <code>ssh-keyscan</code> 결과나 기존 <code>known_hosts</code> 파일의 한
        줄을 그대로 붙여넣어 추가할 수 있습니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <Skeleton />
      ) : entries.length === 0 ? (
        <p className="empty-state">등록된 known_hosts 항목이 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="git-config-table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Key Type</th>
                <th>Fingerprint</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.host}-${index}`}>
                  <td>{entry.host}</td>
                  <td>{entry.keyType}</td>
                  <td className="mono-cell">{entry.fingerprint}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deleting === index}
                      onClick={() => handleDelete(index, entry.host)}
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
        <div className="form-field">
          <label htmlFor="known-host-line">known_hosts 라인</label>
          <textarea
            id="known-host-line"
            className="mono-textarea"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI..."
            rows={2}
            required
          />
        </div>
        {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '추가하는 중...' : '항목 추가'}
        </button>
      </form>
    </div>
  )
}
