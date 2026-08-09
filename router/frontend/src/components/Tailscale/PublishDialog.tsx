import { useState, type FormEvent } from 'react'
import { Sheet } from '../common/Sheet'
import { ErrorBanner } from '../common/ErrorBanner'
import type { TailscalePublish, TailscalePublishMode } from '../../api/types'

// Same add/edit-in-one-dialog shape as ForwardDialog.tsx - name is only
// editable on create (the backend has no rename, only create/update-by-
// name/delete, see tailscale/config.go's own UpdatePublish).
export function PublishDialog({
  publish,
  submitting,
  error,
  onCancel,
  onSave,
}: {
  publish: TailscalePublish | null
  submitting: boolean
  error: string | null
  onCancel: () => void
  onSave: (publish: TailscalePublish) => void
}) {
  const [name, setName] = useState(publish?.name ?? '')
  const [tailscalePort, setTailscalePort] = useState(publish ? String(publish.tailscalePort) : '')
  const [targetHost, setTargetHost] = useState(publish?.targetHost ?? 'code-docker')
  const [localPort, setLocalPort] = useState(publish ? String(publish.localPort) : '')
  const [mode, setMode] = useState<TailscalePublishMode>(publish?.mode ?? 'tcp')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSave({
      name: name.trim(),
      tailscalePort: Number(tailscalePort),
      targetHost: targetHost.trim(),
      localPort: Number(localPort),
      mode,
    })
  }

  return (
    <Sheet open onClose={onCancel} title={publish ? 'publish 편집' : 'publish 추가'}>
      <form onSubmit={handleSubmit} className="dialog-form">
        <div className="form-field">
          <label htmlFor="pub-name">이름</label>
          <input
            id="pub-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={publish !== null}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="pub-tailscale-port">tailscale 포트</label>
          <input
            id="pub-tailscale-port"
            type="number"
            min={1}
            value={tailscalePort}
            onChange={(e) => setTailscalePort(e.target.value)}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="pub-target-host">대상 호스트</label>
          <input
            id="pub-target-host"
            value={targetHost}
            onChange={(e) => setTargetHost(e.target.value)}
            placeholder="code-docker"
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="pub-local-port">로컬 포트</label>
          <input
            id="pub-local-port"
            type="number"
            min={1}
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value)}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="pub-mode">모드</label>
          <select id="pub-mode" value={mode} onChange={(e) => setMode(e.target.value as TailscalePublishMode)}>
            <option value="tcp">tcp</option>
            <option value="tls-terminated-tcp">tls-terminated-tcp</option>
          </select>
        </div>
        {error && <ErrorBanner message={error} />}
        <div className="dialog-actions">
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
