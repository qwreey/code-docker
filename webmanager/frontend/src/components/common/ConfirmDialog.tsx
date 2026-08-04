import { useEffect, useRef, useState, type ReactNode } from 'react'
import '../common/common.css'
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
  requireTypedConfirmation?: string
  requireCheckbox?: string
}

// Generic destructive-action confirm dialog, replacing window.confirm() and
// the two near-duplicate dialogs it used to inspire (Processes/
// KillConfirmDialog, Projects/DeleteReclaimableDialog). A native confirm()'s
// OK button is a single reflex Enter press away, which is exactly wrong for
// an irreversible action: initial focus goes to Cancel, Enter is never bound
// to the confirm action (only an explicit click, or deliberately tabbing to
// it, confirms), and Escape still cancels. requireTypedConfirmation and
// requireCheckbox are opt-in extra gates that also keep the confirm button
// disabled until satisfied; both reset whenever the dialog re-opens.
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
  requireTypedConfirmation,
  requireCheckbox,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [typedValue, setTypedValue] = useState('')
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (!open) return
    setTypedValue('')
    setChecked(false)
    cancelRef.current?.focus()
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

  const typedOk = !requireTypedConfirmation || typedValue === requireTypedConfirmation
  const checkboxOk = !requireCheckbox || checked
  const confirmDisabled = busy || !typedOk || !checkboxOk

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

        {requireTypedConfirmation && (
          <div className="form-field confirm-dialog-typed">
            <label htmlFor="confirm-dialog-typed-input">
              계속하려면 <code>{requireTypedConfirmation}</code>을(를) 정확히 입력하세요
            </label>
            <input
              id="confirm-dialog-typed-input"
              type="text"
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              autoComplete="off"
              disabled={busy}
            />
          </div>
        )}

        {requireCheckbox && (
          <label className="confirm-dialog-checkbox">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              disabled={busy}
            />
            {requireCheckbox}
          </label>
        )}

        <div className="confirm-dialog-actions">
          <button type="button" className="btn btn-secondary" ref={cancelRef} onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
