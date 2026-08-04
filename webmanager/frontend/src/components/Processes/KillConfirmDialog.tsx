import { useEffect, useRef } from 'react'
import type { ProcessSignal } from '../../api/types'
import './KillConfirmDialog.css'

const SIGNAL_LABEL: Record<ProcessSignal, string> = {
  TERM: '종료',
  KILL: '강제 종료',
}

interface KillConfirmDialogProps {
  pid: number
  label: string
  signal: ProcessSignal
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

// Replaces window.confirm() for the process kill action - a native confirm
// dialog's OK button is reachable with a single reflex Enter press, which is
// exactly the wrong default for a destructive, irreversible action. This
// dialog puts initial focus on Cancel instead (so a stray Enter is a no-op)
// and never binds Enter to the kill action itself; only clicking the danger
// button (or tabbing to it deliberately) confirms. Escape still cancels.
export function KillConfirmDialog({ pid, label, signal, busy, onCancel, onConfirm }: KillConfirmDialogProps) {
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
    <div className="kill-confirm-backdrop" onClick={onCancel}>
      <div
        className="card kill-confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={`${SIGNAL_LABEL[signal]} 확인`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{SIGNAL_LABEL[signal]} 확인</h2>
        <p className="section-description">
          <strong>{label}</strong> (PID {pid}) 프로세스를 {SIGNAL_LABEL[signal]}하시겠습니까?
          {signal === 'KILL' && ' 강제 종료는 저장되지 않은 작업 내용을 잃을 수 있습니다.'}
        </p>
        <div className="kill-confirm-actions">
          <button type="button" className="btn btn-secondary" ref={cancelRef} onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? '처리 중...' : SIGNAL_LABEL[signal]}
          </button>
        </div>
      </div>
    </div>
  )
}
