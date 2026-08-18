import { useEffect, useState } from 'react'
import { api, errorMessage } from './client'
import type { TailscaleGlobalConfig } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

export function GlobalSettings() {
  const [socksAddress, setSocksAddress] = useState('')
  const [retryInterval, setRetryInterval] = useState(0)
  // Deliberately starts empty, not prefilled with any default - loading the
  // page must never itself make this field "set" (see the PUT below, which
  // sends exactly what's in these fields; an unset-by-the-user value must
  // round-trip as "" the same way an unset TAILSCALE_LOGIN_SERVER env var
  // does today).
  const [loginServer, setLoginServer] = useState('')
  const [loginServerPinned, setLoginServerPinned] = useState(false)
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
        setLoginServer(data.loginServer)
        setLoginServerPinned(data.loginServerPinned)
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
        loginServer,
      })
      setSocksAddress(data.socksAddress)
      setRetryInterval(data.retryInterval)
      setLoginServer(data.loginServer)
      setLoginServerPinned(data.loginServerPinned)
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
      {loginServerPinned && (
        <ErrorBanner
          variant="warning"
          message="TAILSCALE_LOGIN_SERVER 환경변수로 고정되어 있습니다 - 여기서 바꿀 수 없습니다."
        />
      )}
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
            <div className="form-field">
              <label htmlFor="ts-login-server">로그인 서버 (Headscale 등)</label>
              <input
                id="ts-login-server"
                value={loginServer}
                onChange={(e) => setLoginServer(e.target.value)}
                placeholder="비워두면 tailscale.com 공식 서버 사용"
                disabled={loginServerPinned}
              />
            </div>
          </div>
          <p className="form-hint">
            저장만으로는 즉시 반영되지 않습니다 - 아직 로그인 전이라면 아래 상태 카드의 "로그인 시도하기"로 다음
            로그인 시도부터 적용됩니다. 이미 다른 서버로 로그인되어 있다면 "재인증"만으로 서버 전환이 안전하게
            처리되는지 확인되지 않았습니다 - 문서의 "호스트네임 지정 / 자체 호스팅 로그인 서버" 절차(상태
            디렉터리 초기화 후 재시작)를 권장합니다.
          </p>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? '저장하는 중...' : saved ? '저장됨 (tailscale-forward 재시작됨)' : '저장'}
          </button>
        </form>
      )}
    </div>
  )
}
