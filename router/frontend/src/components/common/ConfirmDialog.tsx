import { useEffect, useRef, type ReactNode } from 'react'
import './common.css'
import './ConfirmDialog.css'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  children?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  busyLabel?: string
}

// Ported from webmanager's own components/common/ConfirmDialog.tsx (see that
// file's doc comment for the rationale) - replaces window.confirm(), whose
// OK button is a single reflex Enter press away for a destructive action,
// and which some automated test/agent harnesses can't dismiss at all.
// requireTypedConfirmation/requireCheckbox weren't ported since nothing in
// this package needs them yet - add them back here if a future caller does,
// rather than diverging the two copies' props.
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = '확인',
  cancelLabel = '취소',
  danger = true,
  busy = false,
  busyLabel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="confirm-dialog-backdrop" onClick={onClose}>
      <div
        className="card confirm-dialog-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        {children && <div className="confirm-dialog-message">{children}</div>}
        <div className="confirm-dialog-actions">
          <button type="button" className="btn btn-secondary" ref={cancelRef} onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
