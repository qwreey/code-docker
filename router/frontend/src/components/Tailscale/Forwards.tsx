import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from './client'
import type { TailscaleForward } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

export function Forwards() {
  const [forwards, setForwards] = useState<TailscaleForward[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [localPort, setLocalPort] = useState('')
  const [remoteHost, setRemoteHost] = useState('')
  const [remotePort, setRemotePort] = useState('')
  const [retryInterval, setRetryInterval] = useState('0')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<TailscaleForward[]>('/forwards')
      setForwards(data)
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
    setNotice('저장됨 (tailscale-forward 재시작됨)')
    setTimeout(() => setNotice(null), 2500)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await api.post('/forwards', {
        name,
        localPort: Number(localPort),
        remoteHost,
        remotePort: Number(remotePort),
        retryInterval: Number(retryInterval) || 0,
      })
      setName('')
      setLocalPort('')
      setRemoteHost('')
      setRemotePort('')
      setRetryInterval('0')
      await load()
      showNotice()
    } catch (e) {
      setFormError(errorMessage(e))
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(forwardName: string) {
    if (!window.confirm(`"${forwardName}" forward를 삭제하시겠습니까?`)) return
    setDeleting(forwardName)
    try {
      await api.del(`/forwards/${encodeURIComponent(forwardName)}`)
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
      <h2>Forwards</h2>
      <p className="section-description">원격 tailnet 피어의 포트를 로컬로 끌어옵니다.</p>
      <div className="info-note">
        <span aria-hidden="true">ℹ</span>
        <span>
          이 항목으로 가져온 포트는 컨테이너 안에서 <code>localhost</code>가 아니라 <code>forward</code>{' '}
          호스트네임으로 접근하세요.
        </span>
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <p className="success-note">{notice}</p>}

      {loading ? (
        <Skeleton />
      ) : forwards.length === 0 ? (
        <p className="empty-state">등록된 forward가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="tailscale-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>로컬 포트</th>
                <th>원격 호스트</th>
                <th>원격 포트</th>
                <th>재시도 간격(초)</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {forwards.map((f) => (
                <tr key={f.name}>
                  <td>{f.name}</td>
                  <td>{f.localPort}</td>
                  <td>{f.remoteHost}</td>
                  <td>{f.remotePort}</td>
                  <td>{f.retryInterval || '기본값'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deleting === f.name}
                      onClick={() => handleDelete(f.name)}
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
            <label htmlFor="fwd-name">이름</label>
            <input id="fwd-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-field">
            <label htmlFor="fwd-local-port">로컬 포트</label>
            <input
              id="fwd-local-port"
              type="number"
              min={1}
              value={localPort}
              onChange={(e) => setLocalPort(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="fwd-remote-host">원격 호스트</label>
            <input
              id="fwd-remote-host"
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
              placeholder="peer.tailnet.ts.net"
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="fwd-remote-port">원격 포트</label>
            <input
              id="fwd-remote-port"
              type="number"
              min={1}
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="fwd-retry-interval">재시도 간격 (초, 0 = 기본값 사용)</label>
            <input
              id="fwd-retry-interval"
              type="number"
              min={0}
              value={retryInterval}
              onChange={(e) => setRetryInterval(e.target.value)}
            />
          </div>
        </div>
        {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '추가하는 중...' : 'forward 추가'}
        </button>
      </form>
    </div>
  )
}
