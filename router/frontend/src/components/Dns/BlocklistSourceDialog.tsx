import { useState, type FormEvent } from 'react'
import { Sheet } from '../common/Sheet'
import { ErrorBanner } from '../common/ErrorBanner'
import type { DnsBlocklistSource } from '../../api/types'

// Same add/edit-in-one-dialog shape as Dev Proxy's RouteDialog.tsx - name is
// only editable on create (the backend has no rename, only create/update-by-
// name/delete, see blocklist.go's own CreateSource/UpdateSource split).
export function BlocklistSourceDialog({
  source,
  submitting,
  error,
  onCancel,
  onSave,
}: {
  source: DnsBlocklistSource | null
  submitting: boolean
  error: string | null
  onCancel: () => void
  onSave: (name: string, hosts: string[]) => void
}) {
  const [name, setName] = useState(source?.name ?? '')
  const [hostsText, setHostsText] = useState((source?.hosts ?? []).join('\n'))

  function parseHosts(text: string): string[] {
    return text
      .split('\n')
      .map((h) => h.trim())
      .filter((h) => h.length > 0)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSave(name.trim(), parseHosts(hostsText))
  }

  return (
    <Sheet open onClose={onCancel} title={source ? '블록리스트 편집' : '블록리스트 추가'}>
      <form onSubmit={handleSubmit} className="dialog-form">
        <div className="form-field">
          <label htmlFor="bl-name">이름</label>
          <input
            id="bl-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-list"
            disabled={source !== null}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="bl-hosts">호스트 이름 (한 줄에 하나)</label>
          <textarea
            id="bl-hosts"
            rows={10}
            value={hostsText}
            onChange={(e) => setHostsText(e.target.value)}
            placeholder={'ads.example.com\ntracker.example.net'}
          />
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
