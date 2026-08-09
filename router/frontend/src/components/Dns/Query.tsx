import { useState } from 'react'
import { api, errorMessage } from './client'
import type { DnsQueryResult } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'PTR', 'SRV', 'ANY', 'ALL']

// dig-style debugging lookup against this container's own dnsmasq
// (127.0.0.1:53) - shows exactly what code-docker/dind would get back,
// including blocklist 0.0.0.0 answers and custom-hosts entries. Cache
// inspection/clearing is out of scope (too tied to dnsmasq/host internals,
// scoped out by the request that designed this) - `dig`'s raw output
// (answer section + timing footer) is shown as-is rather than reparsed.
export function Query() {
  const [domain, setDomain] = useState('')
  const [type, setType] = useState('A')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<DnsQueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!domain.trim()) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ domain: domain.trim(), type })
      const data = await api.get<DnsQueryResult>(`/query?${params.toString()}`)
      setResult(data)
    } catch (e) {
      setResult(null)
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card">
      <h2>조회</h2>
      <p className="section-description">
        이 컨테이너 자신의 dnsmasq(127.0.0.1)로 dig 조회를 실행합니다 - code-docker/dind이 실제로
        받는 응답(블록리스트, 추가 호스트, 캐시 여부 포함)을 그대로 확인할 수 있습니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <form onSubmit={handleSubmit}>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="dns-query-domain">도메인</label>
            <input
              id="dns-query-domain"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
            />
          </div>
          <div className="form-field">
            <label htmlFor="dns-query-type">레코드 타입</label>
            <select id="dns-query-type" value={type} onChange={(e) => setType(e.target.value)}>
              {RECORD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === 'ALL' ? 'ALL (A/AAAA/CNAME/MX/TXT/NS/SOA/SRV)' : t}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading || !domain.trim()}>
          {loading ? '조회하는 중...' : '조회'}
        </button>
      </form>
      {result && (
        <div className="dns-query-result">
          <p className="section-description">
            {result.domain} ({result.type}) - {result.durationMs}ms
          </p>
          <pre className="dns-query-output">{result.output || '(응답 없음)'}</pre>
        </div>
      )}
    </div>
  )
}
