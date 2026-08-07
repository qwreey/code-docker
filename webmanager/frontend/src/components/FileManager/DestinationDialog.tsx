import { useState, type FormEvent } from 'react'
import { Sheet } from '@code-docker/router-frontend'
import './FileManager.css'

export function DestinationDialog({
  mode,
  count,
  initialDir,
  busy,
  onCancel,
  onConfirm,
}: {
  mode: 'move' | 'copy'
  count: number
  initialDir: string
  busy: boolean
  onCancel: () => void
  onConfirm: (destDir: string) => void
}) {
  const [destDir, setDestDir] = useState(initialDir)
  const label = mode === 'move' ? '이동' : '복사'

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (destDir.trim()) onConfirm(destDir.trim())
  }

  return (
    <Sheet open onClose={onCancel} title={`${label}할 위치 선택`}>
      <p className="section-description">
        {count}개 항목을 {label}할 대상 디렉토리의 전체 경로를 입력하세요.
      </p>
      <form onSubmit={handleSubmit}>
        <div className="form-field">
          <label htmlFor="fm-dest-dir">대상 디렉토리</label>
          <input
            id="fm-dest-dir"
            value={destDir}
            onChange={(e) => setDestDir(e.target.value)}
            autoFocus
            required
            disabled={busy}
          />
        </div>
        <div className="file-manager-dialog-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="submit" className="btn btn-primary btn-small" disabled={busy || !destDir.trim()}>
            {busy ? `${label} 중...` : label}
          </button>
        </div>
      </form>
    </Sheet>
  )
}
