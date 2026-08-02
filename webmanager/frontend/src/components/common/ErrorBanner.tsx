import './common.css'

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" className="error-banner-dismiss" onClick={onDismiss} aria-label="닫기">
          ✕
        </button>
      )}
    </div>
  )
}
