import { useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { ProcessSignal } from '../../api/types'
import { KillConfirmDialog } from './KillConfirmDialog'

interface KillButtonsProps {
  pid: number
  label: string
  disabled?: boolean
  onKilled: () => void
  onError: (message: string) => void
}

export function KillButtons({ pid, label, disabled, onKilled, onError }: KillButtonsProps) {
  const [busy, setBusy] = useState(false)
  const [pendingSignal, setPendingSignal] = useState<ProcessSignal | null>(null)

  if (disabled) {
    return <span className="process-kill-none">—</span>
  }

  async function confirmSend() {
    const signal = pendingSignal
    if (!signal) return
    setBusy(true)
    try {
      await api.post(`/processes/${pid}/signal`, { signal })
      onKilled()
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setBusy(false)
      setPendingSignal(null)
    }
  }

  return (
    <div className="process-kill-actions">
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => setPendingSignal('TERM')}>
        종료
      </button>
      <button
        type="button"
        className="btn btn-danger btn-small"
        disabled={busy}
        onClick={() => setPendingSignal('KILL')}
      >
        강제 종료
      </button>
      {pendingSignal && (
        <KillConfirmDialog
          pid={pid}
          label={label}
          signal={pendingSignal}
          busy={busy}
          onCancel={() => setPendingSignal(null)}
          onConfirm={confirmSend}
        />
      )}
    </div>
  )
}
