import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from './client'
import type { TailscaleForward } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { ForwardDialog } from './ForwardDialog'
import { withViewTransition } from '../../utils/viewTransition'

export function Forwards() {
  const [forwards, setForwards] = useState<TailscaleForward[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ forward: TailscaleForward | null } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

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

  async function handleSave(forward: TailscaleForward) {
    setSubmitting(true)
    setDialogError(null)
    try {
      if (dialog?.forward) {
        await api.put(`/forwards/${encodeURIComponent(forward.name)}`, forward)
      } else {
        await api.post('/forwards', forward)
      }
      setDialog(null)
      await load()
      showNotice()
    } catch (e) {
      setDialogError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(forwardName: string) {
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
      setConfirmDelete(null)
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2>Forwards</h2>
        <button type="button" className="btn btn-primary btn-small" onClick={() => setDialog({ forward: null })}>
          forward 추가
        </button>
      </div>
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
                <th aria-label="동작" className="table-actions-col" />
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
                  <td className="table-actions-col">
                    <button type="button" className="btn btn-small" onClick={() => setDialog({ forward: f })}>
                      편집
                    </button>{' '}
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deleting === f.name}
                      onClick={() => setConfirmDelete(f.name)}
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

      {dialog && (
        <ForwardDialog
          forward={dialog.forward}
          submitting={submitting}
          error={dialogError}
          onCancel={() => setDialog(null)}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete !== null && handleDelete(confirmDelete)}
        title="forward 삭제"
        confirmLabel="삭제"
        busy={deleting !== null}
      >
        &quot;{confirmDelete}&quot; forward를 삭제하시겠습니까?
      </ConfirmDialog>
    </div>
  )
}
