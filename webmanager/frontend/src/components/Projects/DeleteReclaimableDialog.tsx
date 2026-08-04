import { useEffect, useRef } from 'react'
import type { ReclaimableEntry } from '../../api/types'
import { formatBytes } from '../../utils/format'
import './DeleteReclaimableDialog.css'

interface DeleteReclaimableDialogProps {
  entry: ReclaimableEntry
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

// Same design principle as Processes/KillConfirmDialog: a native
// window.confirm()'s OK button is a single reflex Enter press away, which is
// exactly wrong for an irreversible os.RemoveAll. Initial focus goes to
// Cancel, Enter is never bound to the delete action (only an explicit click
// on the danger button, or deliberately tabbing to it, confirms), and Escape
// still cancels.
export function DeleteReclaimableDialog({ entry, busy, onCancel, onConfirm }: DeleteReclaimableDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return (
    <div className="delete-reclaimable-backdrop" onClick={onCancel}>
      <div
        className="card delete-reclaimable-card"
        role="alertdialog"
        aria-modal="true"
        aria-label="폴더 삭제 확인"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>폴더 삭제 확인</h2>
        <p className="section-description">
          다음 폴더를 디스크에서 완전히 삭제합니다. 이 작업은 되돌릴 수 없습니다(단,{' '}
          <code>{entry.pattern}</code>류 폴더는 대부분 다시 설치/빌드하면 재생성됩니다).
        </p>
        <div className="delete-reclaimable-target">
          <div className="mono-cell delete-reclaimable-path">{entry.path}</div>
          <div className="delete-reclaimable-size">{formatBytes(entry.sizeBytes)}</div>
        </div>
        <div className="delete-reclaimable-actions">
          <button type="button" className="btn btn-secondary" ref={cancelRef} onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? '삭제 중...' : '삭제'}
          </button>
        </div>
      </div>
    </div>
  )
}
