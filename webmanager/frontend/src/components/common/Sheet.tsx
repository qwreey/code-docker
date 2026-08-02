import { useEffect, useRef, type ReactNode } from 'react'
import './Sheet.css'

export function Sheet({
  open,
  onClose,
  title,
  children,
  headerActions,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  headerActions?: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (open) dialogRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet-content"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <h3>{title}</h3>
          <div className="sheet-header-actions">
            {headerActions}
            <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
              닫기
            </button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}
