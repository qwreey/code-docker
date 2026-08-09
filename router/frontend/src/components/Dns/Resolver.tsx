import { useEffect, useState } from 'react'
import { api, errorMessage } from './client'
import type { DnsResolverConfig, DnsResolverMode } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

// Upstream DNS override - "auto" (default) reads this container's own
// /etc/resolv.conf (Docker-filled from the host), "custom" pins a fixed
// server list (e.g. 1.1.1.1) via dnsmasq's --no-resolv --server= flags -
// confirmed feasible purely in userspace, see the plan doc.
export function Resolver() {
  const [mode, setMode] = useState<DnsResolverMode>('auto')
  const [serversText, setServersText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<DnsResolverConfig>('/resolver')
      .then((data) => {
        if (cancelled) return
        setMode(data.mode)
        setServersText(data.servers.join('\n'))
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) withViewTransition(() => setLoading(false))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const servers = serversText
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const data = await api.put<DnsResolverConfig>('/resolver', { mode, servers })
      setMode(data.mode)
      setServersText(data.servers.join('\n'))
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
      <h2>리졸버</h2>
      <p className="section-description">
        이 라우터를 DNS 서버로 사용하는 컨테이너가 실제로 조회하게 될 업스트림 DNS 서버를 지정합니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {saved && <p className="success-note">저장됨 (dns 재시작됨)</p>}
      {loading ? (
        <Skeleton />
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="resolver-mode">모드</label>
              <select id="resolver-mode" value={mode} onChange={(e) => setMode(e.target.value as DnsResolverMode)}>
                <option value="auto">자동 (컨테이너의 /etc/resolv.conf 사용)</option>
                <option value="custom">직접 지정</option>
              </select>
            </div>
            {mode === 'custom' && (
              <div className="form-field">
                <label htmlFor="resolver-servers">서버 (한 줄에 하나)</label>
                <textarea
                  id="resolver-servers"
                  rows={3}
                  value={serversText}
                  onChange={(e) => setServersText(e.target.value)}
                  placeholder={'1.1.1.1\n8.8.8.8'}
                />
              </div>
            )}
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? '저장하는 중...' : '저장'}
          </button>
        </form>
      )}
    </div>
  )
}
