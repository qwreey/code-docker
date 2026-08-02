import { useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { ProcessSignal } from '../../api/types'

interface KillButtonsProps {
  pid: number
  label: string
  disabled?: boolean
  onKilled: () => void
  onError: (message: string) => void
}

const SIGNAL_LABEL: Record<ProcessSignal, string> = {
  TERM: '종료',
  KILL: '강제 종료',
}

export function KillButtons({ pid, label, disabled, onKilled, onError }: KillButtonsProps) {
  const [busy, setBusy] = useState(false)

  if (disabled) {
    return <span className="process-kill-none">—</span>
  }

  async function send(signal: ProcessSignal) {
    if (!window.confirm(`${label} (PID ${pid}) 프로세스를 ${SIGNAL_LABEL[signal]}하시겠습니까?`)) return
    setBusy(true)
    try {
      await api.post(`/processes/${pid}/signal`, { signal })
      onKilled()
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="process-kill-actions">
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => send('TERM')}>
        종료
      </button>
      <button type="button" className="btn btn-danger btn-small" disabled={busy} onClick={() => send('KILL')}>
        강제 종료
      </button>
    </div>
  )
}
