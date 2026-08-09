import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, errorMessage } from '../../api/client'
import type { GpgKey, GpgKeyCreated } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { CopyButton } from '../common/CopyButton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import '../common/common.css'
import { withViewTransition } from '../../utils/viewTransition'

const NOT_INSTALLED_NOTICE = '컨테이너에 gnupg가 아직 설치되어 있지 않습니다 (다음 이미지 빌드부터 사용 가능합니다).'

function isNotInstalled(e: unknown): boolean {
  return e instanceof ApiError && e.status === 501
}

export function GpgKeys({ onUseKey }: { onUseKey: (keyId: string) => void }) {
  const [keys, setKeys] = useState<GpgKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notInstalled, setNotInstalled] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createNotInstalled, setCreateNotInstalled] = useState(false)
  const [createdKey, setCreatedKey] = useState<GpgKeyCreated | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<GpgKey[]>('/git/gpg-keys')
      setKeys(data)
      setError(null)
      setNotInstalled(false)
    } catch (e) {
      if (isNotInstalled(e)) {
        setNotInstalled(true)
        setError(null)
      } else {
        setError(errorMessage(e))
      }
    } finally {
      withViewTransition(() => setLoading(false))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setCreateError(null)
    setCreateNotInstalled(false)
    try {
      const data = await api.post<GpgKeyCreated>('/git/gpg-keys', { name, email })
      setCreatedKey(data)
      setName('')
      setEmail('')
      await load()
    } catch (e) {
      if (isNotInstalled(e)) {
        setCreateNotInstalled(true)
      } else {
        setCreateError(errorMessage(e))
      }
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(keyId: string) {
    setDeleting(keyId)
    try {
      await api.del(`/git/gpg-keys/${encodeURIComponent(keyId)}`)
      if (createdKey?.keyId === keyId) setCreatedKey(null)
      await load()
    } catch (e) {
      if (isNotInstalled(e)) {
        setNotInstalled(true)
      } else {
        setError(errorMessage(e))
      }
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
  }

  if (notInstalled) {
    return (
      <div className="gpg-keys-section">
        <div className="warning-note">
          <span aria-hidden="true">⚠️</span>
          <span>{NOT_INSTALLED_NOTICE}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="gpg-keys-section">
      <h3>GPG 키</h3>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <Skeleton />
      ) : keys.length === 0 ? (
        <p className="empty-state">등록된 GPG 키가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="git-config-table">
            <thead>
              <tr>
                <th>Key ID</th>
                <th>UID</th>
                <th>생성일</th>
                <th aria-label="동작" className="table-actions-col" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.keyId}>
                  <td className="mono-cell">{k.keyId}</td>
                  <td>{k.uid}</td>
                  <td>{k.createdAt}</td>
                  <td className="table-actions-col">
                    <div className="gpg-key-row-actions">
                      <button type="button" className="btn btn-secondary btn-small" onClick={() => onUseKey(k.keyId)}>
                        이 키를 서명 키로 사용
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-small"
                        disabled={deleting === k.keyId}
                        onClick={() => setConfirmDelete(k.keyId)}
                      >
                        삭제
                      </button>
                    </div>
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
            새 GPG 키 <strong>{createdKey.keyId}</strong>가 생성되었습니다 (아직 저장되지 않음 — <strong>저장</strong> 버튼을
            눌러야 적용됩니다). 이 공개키를 GitHub/GitLab의 서명 검증 키(signing key)로 등록하세요.
          </p>
          <div className="copyable-block">
            <code>{createdKey.publicKey}</code>
            <CopyButton text={createdKey.publicKey} />
          </div>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => onUseKey(createdKey.keyId)}>
            이 키를 서명 키로 사용
          </button>
        </div>
      )}

      <form onSubmit={handleCreate} className="form-grid-inline">
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="gpg-name">이름</label>
            <input id="gpg-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-field">
            <label htmlFor="gpg-email">이메일</label>
            <input
              id="gpg-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
        </div>
        {createNotInstalled && (
          <div className="warning-note">
            <span aria-hidden="true">⚠️</span>
            <span>{NOT_INSTALLED_NOTICE}</span>
          </div>
        )}
        {createError && <ErrorBanner message={createError} onDismiss={() => setCreateError(null)} />}
        <button type="submit" className="btn btn-primary" disabled={creating}>
          {creating ? '생성하는 중...' : '새 GPG 키 생성'}
        </button>
      </form>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete !== null && handleDelete(confirmDelete)}
        title="GPG 키 삭제"
        confirmLabel="삭제"
        busy={deleting !== null}
      >
        &quot;{confirmDelete}&quot; GPG 키를 삭제하시겠습니까?
      </ConfirmDialog>
    </div>
  )
}
