import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { TailscalePublish, TailscalePublishMode } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'

export function Publish() {
  const [publishes, setPublishes] = useState<TailscalePublish[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [tailscalePort, setTailscalePort] = useState('')
  const [localPort, setLocalPort] = useState('')
  const [mode, setMode] = useState<TailscalePublishMode>('tcp')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<TailscalePublish[]>('/tailscale/publish')
      setPublishes(data)
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

  function showNotice() {
    setNotice('저장됨 (tailscale-forward 재시작됨)')
    setTimeout(() => setNotice(null), 2500)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await api.post('/tailscale/publish', {
        name,
        tailscalePort: Number(tailscalePort),
        localPort: Number(localPort),
        mode,
      })
      setName('')
      setTailscalePort('')
      setLocalPort('')
      setMode('tcp')
      await load()
      showNotice()
    } catch (e) {
      setFormError(errorMessage(e))
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(publishName: string) {
    if (!window.confirm(`"${publishName}" publish를 삭제하시겠습니까?`)) return
    setDeleting(publishName)
    try {
      await api.del(`/tailscale/publish/${encodeURIComponent(publishName)}`)
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
      <h2>Publish</h2>
      <p className="section-description">로컬 포트를 tailnet 전체에 명시적으로 노출합니다.</p>
      <div className="info-note">
        <span aria-hidden="true">ℹ</span>
        <span>
          게시하려는 서비스는 <code>0.0.0.0</code>/<code>localhost</code>가 아니라 <code>private</code>{' '}
          호스트네임(전용 tailscale IP)에 바인드되어 있어야 합니다.
        </span>
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <p className="success-note">{notice}</p>}

      {loading ? (
        <p className="empty-state">불러오는 중...</p>
      ) : publishes.length === 0 ? (
        <p className="empty-state">등록된 publish가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="tailscale-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>tailscale 포트</th>
                <th>로컬 포트</th>
                <th>모드</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {publishes.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td>{p.tailscalePort}</td>
                  <td>{p.localPort}</td>
                  <td>{p.mode}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deleting === p.name}
                      onClick={() => handleDelete(p.name)}
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
            <label htmlFor="pub-name">이름</label>
            <input id="pub-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-field">
            <label htmlFor="pub-tailscale-port">tailscale 포트</label>
            <input
              id="pub-tailscale-port"
              type="number"
              min={1}
              value={tailscalePort}
              onChange={(e) => setTailscalePort(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="pub-local-port">로컬 포트</label>
            <input
              id="pub-local-port"
              type="number"
              min={1}
              value={localPort}
              onChange={(e) => setLocalPort(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="pub-mode">모드</label>
            <select id="pub-mode" value={mode} onChange={(e) => setMode(e.target.value as TailscalePublishMode)}>
              <option value="tcp">tcp</option>
              <option value="tls-terminated-tcp">tls-terminated-tcp</option>
            </select>
          </div>
        </div>
        {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '추가하는 중...' : 'publish 추가'}
        </button>
      </form>
    </div>
  )
}
