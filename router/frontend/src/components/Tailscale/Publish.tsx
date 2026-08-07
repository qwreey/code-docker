import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from './client'
import type { TailscalePublish, TailscalePublishMode } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

export function Publish() {
  const [publishes, setPublishes] = useState<TailscalePublish[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [tailscalePort, setTailscalePort] = useState('')
  const [targetHost, setTargetHost] = useState('code-docker')
  const [localPort, setLocalPort] = useState('')
  const [mode, setMode] = useState<TailscalePublishMode>('tcp')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<TailscalePublish[]>('/publish')
      setPublishes(data)
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
    setNotice('저장됨 (tailscale-publish 재시작됨)')
    setTimeout(() => setNotice(null), 2500)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await api.post('/publish', {
        name,
        tailscalePort: Number(tailscalePort),
        targetHost,
        localPort: Number(localPort),
        mode,
      })
      setName('')
      setTailscalePort('')
      setTargetHost('code-docker')
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
      await api.del(`/publish/${encodeURIComponent(publishName)}`)
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
      <p className="section-description">
        대상 호스트의 로컬 포트를 tailnet 전체에 명시적으로 노출합니다.
      </p>
      <div className="info-note">
        <span aria-hidden="true">ℹ</span>
        <span>
          로컬 포트는 이 컨테이너(router)가 아니라 <b>대상 호스트</b>의 포트를 가리킵니다 — 대상 호스트는
          router에서 (code-docker-internal 네트워크로) 접근 가능한 아무 컴포즈 서비스 호스트명/IP나
          지정할 수 있습니다(예: <code>code-docker</code>, <code>dind</code>). 자세한 내용은{' '}
          <a
            href="https://github.com/qwreey/code-docker/blob/master/docs/router.md#tailscale"
            target="_blank"
            rel="noreferrer"
          >
            docs/router.md
          </a>
          를 확인하세요.
        </span>
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <p className="success-note">{notice}</p>}

      {loading ? (
        <Skeleton />
      ) : publishes.length === 0 ? (
        <p className="empty-state">등록된 publish가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="tailscale-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>tailscale 포트</th>
                <th>대상 호스트</th>
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
                  <td>{p.targetHost}</td>
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
            <label htmlFor="pub-target-host">대상 호스트</label>
            <input
              id="pub-target-host"
              value={targetHost}
              onChange={(e) => setTargetHost(e.target.value)}
              placeholder="code-docker"
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
