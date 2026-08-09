import { useCallback, useEffect, useState } from 'react'
import { netgateApi, errorMessage } from '../../api/client'
import type { NetgateForward } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { withViewTransition } from '../../utils/viewTransition'

export function Forwards() {
  const [forwards, setForwards] = useState<NetgateForward[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [hostPort, setHostPort] = useState('')
  const [targetHost, setTargetHost] = useState('')
  const [targetPort, setTargetPort] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [confirmPort, setConfirmPort] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await netgateApi.get<NetgateForward[]>('/forwards')
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
    setNotice('저장됨 (최대 30초 내 반영)')
    setTimeout(() => setNotice(null), 3000)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await netgateApi.post('/forwards', {
        hostPort: Number(hostPort),
        targetHost,
        targetPort: Number(targetPort),
      })
      setHostPort('')
      setTargetHost('')
      setTargetPort('')
      await load()
      showNotice()
    } catch (e) {
      setFormError(errorMessage(e))
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(port: number) {
    setDeleting(port)
    try {
      await netgateApi.del(`/forwards/${port}`)
      await load()
      showNotice()
    } catch (e) {
      await load()
      setError(errorMessage(e))
    } finally {
      setDeleting(null)
      setConfirmPort(null)
    }
  }

  return (
    <div className="card">
      <h2>포트 포워딩</h2>
      <p className="section-description">
        호스트의 특정 포트를 내부 네트워크에 있는 컨테이너의 포트로 전달합니다(홈 라우터의 포트포워딩과 동일).
        변경사항은 최대 30초 내 반영됩니다(재시작 불필요).
      </p>
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
                <th>호스트 포트</th>
                <th>대상 호스트</th>
                <th>대상 포트</th>
                <th aria-label="동작" className="table-actions-col" />
              </tr>
            </thead>
            <tbody>
              {forwards.map((f) => (
                <tr key={f.hostPort}>
                  <td>{f.hostPort}</td>
                  <td>{f.targetHost}</td>
                  <td>{f.targetPort}</td>
                  <td className="table-actions-col">
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deleting === f.hostPort}
                      onClick={() => setConfirmPort(f.hostPort)}
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

      <ConfirmDialog
        open={confirmPort !== null}
        onClose={() => setConfirmPort(null)}
        onConfirm={() => confirmPort !== null && handleDelete(confirmPort)}
        title="forward 삭제"
        confirmLabel="삭제"
        busy={deleting !== null}
      >
        호스트 포트 {confirmPort} forward를 삭제하시겠습니까?
      </ConfirmDialog>

      <form onSubmit={handleSubmit} className="form-grid-inline">
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="netgate-fwd-host-port">호스트 포트</label>
            <input
              id="netgate-fwd-host-port"
              type="number"
              min={1}
              max={65535}
              value={hostPort}
              onChange={(e) => setHostPort(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="netgate-fwd-target-host">대상 호스트</label>
            <input
              id="netgate-fwd-target-host"
              value={targetHost}
              onChange={(e) => setTargetHost(e.target.value)}
              placeholder="code-docker"
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="netgate-fwd-target-port">대상 포트</label>
            <input
              id="netgate-fwd-target-port"
              type="number"
              min={1}
              max={65535}
              value={targetPort}
              onChange={(e) => setTargetPort(e.target.value)}
              required
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
