import type { ReactNode } from 'react'
import './common.css'

// Ported from router/frontend/src/components/common/ErrorBanner.tsx (was
// imported from @code-docker/router-frontend until 2026-08-08's decoupling
// - see .claude/backlog/router-frontend-decouple-plan.md). Kept as a
// deliberate duplicate rather than a shared package - the two frontends
// are meant to be splittable into separate repos eventually, and this
// component is small/stable enough that hand-syncing is cheaper than the
// workspace-coupling cost (same reasoning webmanager's own common.css
// already gives for .warning-note).
export function ErrorBanner({
  message,
  onDismiss,
  variant = 'error',
}: {
  message: ReactNode
  onDismiss?: () => void
  variant?: 'error' | 'warning'
}) {
  return (
    <div className={variant === 'warning' ? 'error-banner warning-banner' : 'error-banner'} role="alert">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" className="error-banner-dismiss" onClick={onDismiss} aria-label="닫기">
          ✕
        </button>
      )}
    </div>
  )
}
