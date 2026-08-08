import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from './client'
import type { DnsHostEntry } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

// A MagicDNS-style feature: map a hostname to a real IP, resolved by
// router's own dnsmasq for code-docker/dind. Edited as a whole-list replace
// (PUT /api/dns/custom-hosts) rather than per-entry CRUD routes - this list
// is expected to stay small, same reasoning tailscale.GlobalConfig's own
// single-PUT covers its few fields with.
export function CustomHosts() {
  const [entries, setEntries] = useState<DnsHostEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.get<DnsHostEntry[]>('/custom-hosts')
      setEntries(data)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function updateEntry(index: number, field: 'host' | 'ip', value: string) {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: value } : e)))
  }

  function addRow() {
    setEntries((prev) => [...prev, { host: '', ip: '' }])
  }

  function removeRow(index: number) {
    setEntries((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const cleaned = entries.map((e) => ({ host: e.host.trim(), ip: e.ip.trim() })).filter((e) => e.host && e.ip)
      const data = await api.put<DnsHostEntry[]>('/custom-hosts', cleaned)
      setEntries(data)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <h2>추가 호스트</h2>
      <p className="section-description">
        특정 호스트 이름을 실제 IP로 직접 매핑합니다(MagicDNS와 비슷한 개념). 블록리스트보다 항상 먼저
        적용됩니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {saved && <p className="success-note">저장됨 (dns 재시작됨)</p>}
      {loading ? (
        <Skeleton />
      ) : (
        <>
          {entries.length === 0 ? (
            <p className="empty-state">등록된 추가 호스트가 없습니다.</p>
          ) : (
            <div className="table-wrapper">
              <table className="dns-table">
                <thead>
                  <tr>
                    <th>호스트 이름</th>
                    <th>IP</th>
                    <th aria-label="동작" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={i}>
                      <td>
                        <input value={e.host} onChange={(ev) => updateEntry(i, 'host', ev.target.value)} placeholder="dev.internal" />
                      </td>
                      <td>
                        <input value={e.ip} onChange={(ev) => updateEntry(i, 'ip', ev.target.value)} placeholder="10.0.0.5" />
                      </td>
                      <td>
                        <button type="button" className="btn btn-danger btn-small" onClick={() => removeRow(i)}>
                          삭제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="dns-diff-actions" style={{ marginTop: '0.9rem' }}>
            <button type="button" className="btn btn-secondary btn-small" onClick={addRow}>
              행 추가
            </button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? '저장하는 중...' : '저장'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
