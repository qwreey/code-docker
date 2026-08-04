import type { ReclaimableEntry } from '../../api/types'
import { formatBytes } from '../../utils/format'
import { ConfirmDialog } from '../common/ConfirmDialog'
import './DeleteReclaimableDialog.css'

interface DeleteReclaimableDialogProps {
  entry: ReclaimableEntry
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteReclaimableDialog({ entry, busy, onCancel, onConfirm }: DeleteReclaimableDialogProps) {
  return (
    <ConfirmDialog
      open
      onClose={onCancel}
      onConfirm={onConfirm}
      title="폴더 삭제 확인"
      confirmLabel="삭제"
      busyLabel="삭제 중..."
      busy={busy}
    >
      <p>
        다음 폴더를 디스크에서 완전히 삭제합니다. 이 작업은 되돌릴 수 없습니다(단,{' '}
        <code>{entry.pattern}</code>류 폴더는 대부분 다시 설치/빌드하면 재생성됩니다).
      </p>
      <div className="delete-reclaimable-target">
        <div className="mono-cell delete-reclaimable-path">{entry.path}</div>
        <div className="delete-reclaimable-size">{formatBytes(entry.sizeBytes)}</div>
      </div>
    </ConfirmDialog>
  )
}
