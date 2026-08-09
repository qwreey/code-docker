import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { SshEntry } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Sheet } from '../common/Sheet'
import { Skeleton } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SshDefaultKey } from './SshDefaultKey'
import { SshHosts } from './SshHosts'
import { KnownHosts } from './KnownHosts'
import { SshConfigRaw } from './SshConfigRaw'
import '../common/common.css'
import './SshKeys.css'
import { withViewTransition } from '../../utils/viewTransition'

// GET /api/ssh/keys returns the whole authorized_keys file as an ordered
// mix of key entries and standalone "#" comment entries (people use those
// as freeform section markers, e.g. "--- laptop keys below ---") — see
// internal/sshkeys.Entry. Both kinds are shown in one draggable list, in
// file order, and both are editable/deletable/reorderable the same way.

function entryUrl(entry: SshEntry): string {
  return entry.kind === 'comment'
    ? `/ssh/keys/comments/${encodeURIComponent(entry.id)}`
    : `/ssh/keys/${encodeURIComponent(entry.id)}`
}

export function SshKeys() {
  const [entries, setEntries] = useState<SshEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [addKeyOpen, setAddKeyOpen] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [submittingKey, setSubmittingKey] = useState(false)
  const [keyFormError, setKeyFormError] = useState<string | null>(null)

  const [addCommentOpen, setAddCommentOpen] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)
  const [commentFormError, setCommentFormError] = useState<string | null>(null)

  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<SshEntry | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<SshEntry[]>('/ssh/keys')
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

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault()
    if (!newKey.trim()) return
    setSubmittingKey(true)
    setKeyFormError(null)
    try {
      await api.post<SshEntry>('/ssh/keys', { key: newKey.trim() })
      setNewKey('')
      setAddKeyOpen(false)
      await load()
    } catch (e) {
      setKeyFormError(errorMessage(e))
    } finally {
      setSubmittingKey(false)
    }
  }

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault()
    if (!newComment.trim()) return
    setSubmittingComment(true)
    setCommentFormError(null)
    try {
      await api.post<SshEntry>('/ssh/keys/comments', { text: newComment.trim() })
      setNewComment('')
      setAddCommentOpen(false)
      await load()
    } catch (e) {
      setCommentFormError(errorMessage(e))
    } finally {
      setSubmittingComment(false)
    }
  }

  async function handleDelete(entry: SshEntry) {
    setDeletingId(entry.id)
    try {
      await api.del(entryUrl(entry))
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeletingId(null)
      setConfirmDelete(null)
    }
  }

  function startEdit(entry: SshEntry) {
    setEditingId(entry.id)
    setEditValue(entry.kind === 'comment' ? (entry.text ?? '') : (entry.key?.raw ?? ''))
    setEditError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditValue('')
    setEditError(null)
  }

  async function handleSaveEdit(entry: SshEntry) {
    if (!editValue.trim()) return
    setSavingEdit(true)
    setEditError(null)
    try {
      const body = entry.kind === 'comment' ? { text: editValue.trim() } : { key: editValue.trim() }
      await api.put<SshEntry>(entryUrl(entry), body)
      setEditingId(null)
      setEditValue('')
      await load()
    } catch (e) {
      setEditError(errorMessage(e))
    } finally {
      setSavingEdit(false)
    }
  }

  // Drag-and-drop reorder: optimistic locally (reorders `entries` immediately
  // for a snappy drop), then persists via POST /ssh/keys/reorder. Comment ids
  // are index-derived and only valid until the next mutation, so on any
  // failure we reload from the server rather than trusting the optimistic
  // list further.
  async function handleDrop(targetId: string) {
    const draggedId = dragIdRef.current
    dragIdRef.current = null
    setDragOverId(null)
    if (!draggedId || draggedId === targetId) return

    const next = [...entries]
    const fromIndex = next.findIndex((en) => en.id === draggedId)
    const toIndex = next.findIndex((en) => en.id === targetId)
    if (fromIndex === -1 || toIndex === -1) return
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    setEntries(next)

    try {
      const updated = await api.post<SshEntry[]>('/ssh/keys/reorder', { ids: next.map((en) => en.id) })
      setEntries(updated)
    } catch (e) {
      setError(errorMessage(e))
      await load()
    }
  }

  return (
    <section>
      <div className="section-header">
        <h1>SSH Keys</h1>
      </div>
      <p className="section-description">
        컨테이너 SSH 접속을 허용할 공개키 목록입니다 (<code>authorized_keys</code>). <code>#</code>으로 시작하는
        주석 줄로 섹션을 구분할 수 있습니다. 드래그하여 순서를 바꿀 수 있습니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="ssh-keys-toolbar">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setAddCommentOpen(true)}>
          + 주석 추가
        </button>
        <button type="button" className="btn btn-primary btn-small" onClick={() => setAddKeyOpen(true)}>
          + 키 추가
        </button>
      </div>

      {loading ? (
        <Skeleton />
      ) : entries.length === 0 ? (
        <p className="empty-state">등록된 키가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="ssh-keys-table">
            <thead>
              <tr>
                <th aria-label="순서" />
                <th>타입</th>
                <th>코멘트</th>
                <th>지문</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) =>
                editingId === entry.id ? (
                  <tr key={entry.id} className="ssh-key-editing-row">
                    <td colSpan={5}>
                      <div className="ssh-key-edit-form">
                        <textarea
                          className="add-key-textarea"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          rows={entry.kind === 'comment' ? 1 : 3}
                        />
                        {editError && <ErrorBanner message={editError} onDismiss={() => setEditError(null)} />}
                        <div className="ssh-key-edit-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-small"
                            disabled={savingEdit || !editValue.trim()}
                            onClick={() => handleSaveEdit(entry)}
                          >
                            {savingEdit ? '저장하는 중...' : '저장'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-small"
                            disabled={savingEdit}
                            onClick={cancelEdit}
                          >
                            취소
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={entry.id}
                    className={
                      (entry.kind === 'comment' ? 'ssh-comment-row ' : '') +
                      (dragOverId === entry.id ? 'ssh-key-drag-over' : '')
                    }
                    draggable
                    onDragStart={() => {
                      dragIdRef.current = entry.id
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      if (dragOverId !== entry.id) setDragOverId(entry.id)
                    }}
                    onDragLeave={() => setDragOverId((prev) => (prev === entry.id ? null : prev))}
                    onDrop={(e) => {
                      e.preventDefault()
                      handleDrop(entry.id)
                    }}
                    onDragEnd={() => {
                      dragIdRef.current = null
                      setDragOverId(null)
                    }}
                  >
                    <td className="ssh-key-drag-handle-cell">
                      <span className="ssh-key-drag-handle" aria-hidden="true" title="드래그하여 순서 변경">
                        ⠿
                      </span>
                    </td>
                    {entry.kind === 'comment' ? (
                      <td colSpan={3} className="ssh-comment-text">
                        {entry.text}
                      </td>
                    ) : (
                      <>
                        <td>{entry.key?.type}</td>
                        <td>{entry.key?.comment || '-'}</td>
                        <td className="mono-cell">{entry.key?.fingerprint}</td>
                      </>
                    )}
                    <td className="ssh-key-actions">
                      <button type="button" className="btn btn-small" onClick={() => startEdit(entry)}>
                        편집
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-small"
                        disabled={deletingId === entry.id}
                        onClick={() => setConfirmDelete(entry)}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      <Sheet
        open={addKeyOpen}
        onClose={() => {
          setAddKeyOpen(false)
          setKeyFormError(null)
        }}
        title="새 공개키 추가"
      >
        <form onSubmit={handleAddKey} className="add-key-form">
          <textarea
            className="add-key-textarea"
            placeholder="ssh-ed25519 AAAA... user@host"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            rows={3}
            autoFocus
          />
          {keyFormError && <ErrorBanner message={keyFormError} onDismiss={() => setKeyFormError(null)} />}
          <div>
            <button type="submit" className="btn btn-primary" disabled={submittingKey || !newKey.trim()}>
              {submittingKey ? '추가하는 중...' : '키 추가'}
            </button>
          </div>
        </form>
      </Sheet>

      <Sheet
        open={addCommentOpen}
        onClose={() => {
          setAddCommentOpen(false)
          setCommentFormError(null)
        }}
        title="새 주석 추가"
      >
        <p className="section-description">섹션 구분/메모용 줄입니다. 목록 어디로든 드래그해서 옮길 수 있습니다.</p>
        <form onSubmit={handleAddComment} className="add-key-form">
          <textarea
            className="add-key-textarea"
            placeholder="--- 노트북 키 ---"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            rows={1}
            autoFocus
          />
          {commentFormError && (
            <ErrorBanner message={commentFormError} onDismiss={() => setCommentFormError(null)} />
          )}
          <div>
            <button type="submit" className="btn btn-primary" disabled={submittingComment || !newComment.trim()}>
              {submittingComment ? '추가하는 중...' : '주석 추가'}
            </button>
          </div>
        </form>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
        title={confirmDelete?.kind === 'comment' ? '주석 삭제' : '키 삭제'}
        confirmLabel="삭제"
        busy={deletingId !== null}
      >
        {confirmDelete?.kind === 'comment'
          ? '이 주석을 삭제하시겠습니까?'
          : '이 키를 삭제하시겠습니까? 해당 키로는 더 이상 로그인할 수 없습니다.'}
      </ConfirmDialog>

      <SshDefaultKey />
      <SshHosts />
      <KnownHosts />
      <SshConfigRaw />
    </section>
  )
}
