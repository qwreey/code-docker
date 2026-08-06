import type { ReactNode } from 'react'
import './common.css'

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
