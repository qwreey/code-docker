import { useEffect, useState } from 'react'
import { api, errorMessage } from './client'
import type { TailscaleGlobalConfig } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

export function GlobalSettings() {
  const [socksAddress, setSocksAddress] = useState('')
  const [retryInterval, setRetryInterval] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<TailscaleGlobalConfig>('/config')
      .then((data) => {
        if (cancelled) return
        setSocksAddress(data.socksAddress)
        setRetryInterval(data.retryInterval)
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
      const data = await api.put<TailscaleGlobalConfig>('/config', {
        socksAddress,
        retryInterval,
      })
      setSocksAddress(data.socksAddress)
      setRetryInterval(data.retryInterval)
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
      <h2>전역 설정</h2>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="ts-socks-address">SOCKS5 주소</label>
              <input
                id="ts-socks-address"
                value={socksAddress}
                onChange={(e) => setSocksAddress(e.target.value)}
                placeholder="localhost:1055"
              />
            </div>
            <div className="form-field">
              <label htmlFor="ts-retry-interval">재시도 간격 (초)</label>
              <input
                id="ts-retry-interval"
                type="number"
                min={0}
                value={retryInterval}
                onChange={(e) => setRetryInterval(Number(e.target.value))}
              />
            </div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? '저장하는 중...' : saved ? '저장됨 (tailscale-forward 재시작됨)' : '저장'}
          </button>
        </form>
      )}
    </div>
  )
}
