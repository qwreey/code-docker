import { useState, type FormEvent } from 'react'
import { Sheet } from '../common/Sheet'
import { ErrorBanner } from '../common/ErrorBanner'
import type { TailscaleForward } from '../../api/types'

// Same add/edit-in-one-dialog shape as Dev Proxy's RouteDialog.tsx - name is
// only editable on create (the backend has no rename, only create/update-by-
// name/delete, see tailscale/config.go's own UpdateForward).
export function ForwardDialog({
  forward,
  submitting,
  error,
  onCancel,
  onSave,
}: {
  forward: TailscaleForward | null
  submitting: boolean
  error: string | null
  onCancel: () => void
  onSave: (forward: Omit<TailscaleForward, 'retryInterval'> & { retryInterval: number }) => void
}) {
  const [name, setName] = useState(forward?.name ?? '')
  const [localPort, setLocalPort] = useState(forward ? String(forward.localPort) : '')
  const [remoteHost, setRemoteHost] = useState(forward?.remoteHost ?? '')
  const [remotePort, setRemotePort] = useState(forward ? String(forward.remotePort) : '')
  const [retryInterval, setRetryInterval] = useState(forward ? String(forward.retryInterval || 0) : '0')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSave({
      name: name.trim(),
      localPort: Number(localPort),
      remoteHost: remoteHost.trim(),
      remotePort: Number(remotePort),
      retryInterval: Number(retryInterval) || 0,
    })
  }

  return (
    <Sheet open onClose={onCancel} title={forward ? 'forward 편집' : 'forward 추가'}>
      <form onSubmit={handleSubmit} className="tailscale-dialog-form">
        <div className="form-field">
          <label htmlFor="fwd-name">이름</label>
          <input
            id="fwd-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={forward !== null}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="fwd-local-port">로컬 포트</label>
          <input
            id="fwd-local-port"
            type="number"
            min={1}
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value)}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="fwd-remote-host">원격 호스트</label>
          <input
            id="fwd-remote-host"
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
            placeholder="peer.tailnet.ts.net"
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="fwd-remote-port">원격 포트</label>
          <input
            id="fwd-remote-port"
            type="number"
            min={1}
            value={remotePort}
            onChange={(e) => setRemotePort(e.target.value)}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="fwd-retry-interval">재시도 간격 (초, 0 = 기본값 사용)</label>
          <input
            id="fwd-retry-interval"
            type="number"
            min={0}
            value={retryInterval}
            onChange={(e) => setRetryInterval(e.target.value)}
          />
        </div>
        {error && <ErrorBanner message={error} />}
        <div className="tailscale-dialog-actions">
          <button type="submit" className="btn btn-primary btn-small" disabled={submitting}>
            {submitting ? '저장하는 중...' : '저장'}
          </button>
          <button type="button" className="btn btn-small" disabled={submitting} onClick={onCancel}>
            취소
          </button>
        </div>
      </form>
    </Sheet>
  )
}
