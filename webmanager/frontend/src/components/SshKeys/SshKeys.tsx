import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { SshKey } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import '../common/common.css'
import './SshKeys.css'

export function SshKeys() {
  const [keys, setKeys] = useState<SshKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<SshKey[]>('/ssh/keys')
      setKeys(data)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!newKey.trim()) return
    setSubmitting(true)
    setFormError(null)
    try {
      await api.post<SshKey>('/ssh/keys', { key: newKey.trim() })
      setNewKey('')
      await load()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('이 키를 삭제하시겠습니까? 해당 키로는 더 이상 로그인할 수 없습니다.')) return
    setDeletingId(id)
    try {
      await api.del(`/ssh/keys/${encodeURIComponent(id)}`)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section>
      <div className="section-header">
        <h1>SSH Keys</h1>
      </div>
      <p className="section-description">
        컨테이너 SSH 접속을 허용할 공개키 목록입니다 (<code>authorized_keys</code>).
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <p className="empty-state">불러오는 중...</p>
      ) : keys.length === 0 ? (
        <p className="empty-state">등록된 키가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="ssh-keys-table">
            <thead>
              <tr>
                <th>타입</th>
                <th>코멘트</th>
                <th>지문</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.type}</td>
                  <td>{key.comment || '-'}</td>
                  <td className="mono-cell">{key.fingerprint}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deletingId === key.id}
                      onClick={() => handleDelete(key.id)}
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

      <div className="card add-key-card">
        <h2>새 공개키 추가</h2>
        <form onSubmit={handleSubmit} className="add-key-form">
          <textarea
            className="add-key-textarea"
            placeholder="ssh-ed25519 AAAA... user@host"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            rows={3}
          />
          {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
          <div>
            <button type="submit" className="btn btn-primary" disabled={submitting || !newKey.trim()}>
              {submitting ? '추가하는 중...' : '키 추가'}
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}
