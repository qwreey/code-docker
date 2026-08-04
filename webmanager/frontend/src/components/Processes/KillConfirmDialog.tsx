import type { ProcessSignal } from '../../api/types'
import { ConfirmDialog } from '../common/ConfirmDialog'

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

export function KillConfirmDialog({ pid, label, signal, busy, onCancel, onConfirm }: KillConfirmDialogProps) {
  return (
    <ConfirmDialog
      open
      onClose={onCancel}
      onConfirm={onConfirm}
      title={`${SIGNAL_LABEL[signal]} 확인`}
      confirmLabel={SIGNAL_LABEL[signal]}
      busyLabel="처리 중..."
      busy={busy}
    >
      <p>
        <strong>{label}</strong> (PID {pid}) 프로세스를 {SIGNAL_LABEL[signal]}하시겠습니까?
        {signal === 'KILL' && ' 강제 종료는 저장되지 않은 작업 내용을 잃을 수 있습니다.'}
      </p>
    </ConfirmDialog>
  )
}
