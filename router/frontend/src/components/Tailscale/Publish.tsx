import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from './client'
import type { TailscalePublish } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { PublishDialog } from './PublishDialog'
import { withViewTransition } from '../../utils/viewTransition'

export function Publish() {
  const [publishes, setPublishes] = useState<TailscalePublish[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ publish: TailscalePublish | null } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

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

  async function handleSave(publish: TailscalePublish) {
    setSubmitting(true)
    setDialogError(null)
    try {
      if (dialog?.publish) {
        await api.put(`/publish/${encodeURIComponent(publish.name)}`, publish)
      } else {
        await api.post('/publish', publish)
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

  async function handleDelete(publishName: string) {
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
      setConfirmDelete(null)
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2>Publish</h2>
        <button type="button" className="btn btn-primary btn-small" onClick={() => setDialog({ publish: null })}>
          publish 추가
        </button>
      </div>
      <p className="section-description">
        대상 호스트의 로컬 포트를 tailnet 전체에 명시적으로 노출합니다.
      </p>
      <div className="info-note">
        <span aria-hidden="true">ℹ</span>
        <span>
          로컬 포트는 이 컨테이너(router)가 아니라 <b>대상 호스트</b>의 포트를 가리킵니다 — 대상 호스트는
          router에서 접근 가능한 아무 컴포즈 서비스 호스트명/IP나 지정할 수 있습니다(예: <code>code-docker</code>,{' '}
          <code>dind</code>). 자세한 내용은{' '}
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
                <th aria-label="동작" className="table-actions-col" />
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
                  <td className="table-actions-col">
                    <button type="button" className="btn btn-small" onClick={() => setDialog({ publish: p })}>
                      편집
                    </button>{' '}
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deleting === p.name}
                      onClick={() => setConfirmDelete(p.name)}
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
        <PublishDialog
          publish={dialog.publish}
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
        title="publish 삭제"
        confirmLabel="삭제"
        busy={deleting !== null}
      >
        &quot;{confirmDelete}&quot; publish를 삭제하시겠습니까?
      </ConfirmDialog>
    </div>
  )
}
