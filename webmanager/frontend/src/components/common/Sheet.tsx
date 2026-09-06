import { useEffect, useRef, type ReactNode } from 'react'
import './Sheet.css'

// Ported from router/frontend/src/components/common/Sheet.tsx (see
// ErrorBanner.tsx's doc comment on why this is a hand-kept duplicate).
export function Sheet({
  open,
  onClose,
  title,
  children,
  headerActions,
  size = 'default',
  bodyClassName,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  headerActions?: ReactNode
  // 'full' takes the whole viewport instead of the centered 760px card.
  // Added for content that is itself a screen rather than a form - a file
  // browser, a code editor - where the default card plus a phone keyboard
  // leaves a uselessly small strip of actual content.
  size?: 'default' | 'full'
  // Lets a full-screen consumer opt out of .sheet-body's padding/scrolling
  // and manage its own layout instead.
  bodyClassName?: string
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
    <div className={`sheet-backdrop${size === 'full' ? ' sheet-backdrop-full' : ''}`} onClick={onClose}>
      <div
        className={`sheet-content${size === 'full' ? ' sheet-content-full' : ''}`}
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
        <div className={`sheet-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
      </div>
    </div>
  )
}
