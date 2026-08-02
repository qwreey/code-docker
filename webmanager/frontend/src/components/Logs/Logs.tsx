import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { LogEntriesResponse, LogEntry, LogLevel, LogsAppsResponse } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import '../common/common.css'
import './Logs.css'

const LEVEL_OPTIONS: { value: 'all' | LogLevel; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

const LEVEL_BADGE_COLOR: Record<LogLevel, string> = {
  info: 'gray',
  warn: 'yellow',
  error: 'red',
}

const LIMIT = 200
const POLL_INTERVAL_MS = 5000

export function Logs() {
  const [apps, setApps] = useState<string[]>([])
  const [selectedApp, setSelectedApp] = useState('')
  const [level, setLevel] = useState<'all' | LogLevel>('all')
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [mock, setMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [liveRefresh, setLiveRefresh] = useState(false)

  const loadingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<LogsAppsResponse>('/logs/apps')
      .then((data) => {
        if (cancelled) return
        setApps(data.apps)
        setMock((prev) => prev || data.mock)
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const loadEntries = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (selectedApp) params.set('app', selectedApp)
      if (level !== 'all') params.set('level', level)
      params.set('limit', String(LIMIT))
      const data = await api.get<LogEntriesResponse>(`/logs/entries?${params.toString()}`)
      setEntries(data.entries)
      setMock((prev) => prev || data.mock)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [selectedApp, level])

  useEffect(() => {
    loadEntries()
  }, [loadEntries])

  useEffect(() => {
    if (!liveRefresh) return
    const timer = setInterval(loadEntries, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [liveRefresh, loadEntries])

  return (
    <section>
      <div className="section-header">
        <h1>Logs</h1>
        <button type="button" className="btn btn-secondary btn-small" onClick={loadEntries} disabled={loading}>
          {loading ? '불러오는 중...' : '새로고침'}
        </button>
      </div>

      {mock && (
        <div className="warning-note">
          <span aria-hidden="true">⚠</span>
          <span>목업 데이터 — 실제 로그 연동(vector) 예정</span>
        </div>
      )}

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="logs-controls">
        <div className="form-field">
          <label htmlFor="logs-app">앱</label>
          <select id="logs-app" value={selectedApp} onChange={(e) => setSelectedApp(e.target.value)}>
            <option value="">전체</option>
            {apps.map((app) => (
              <option key={app} value={app}>
                {app}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="logs-level">레벨</label>
          <select id="logs-level" value={level} onChange={(e) => setLevel(e.target.value as 'all' | LogLevel)}>
            {LEVEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <label className="logs-live-toggle">
          <input type="checkbox" checked={liveRefresh} onChange={(e) => setLiveRefresh(e.target.checked)} />
          실시간 새로고침
        </label>
      </div>

      {entries.length === 0 ? (
        <p className="empty-state">로그가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="logs-table">
            <thead>
              <tr>
                <th>시간</th>
                <th>레벨</th>
                {!selectedApp && <th>앱</th>}
                <th>메시지</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={i}>
                  <td className="mono-cell">{new Date(entry.timestamp).toLocaleString()}</td>
                  <td>
                    <span className={`badge badge-${LEVEL_BADGE_COLOR[entry.level]}`}>{entry.level}</span>
                  </td>
                  {!selectedApp && <td>{entry.app ?? '-'}</td>}
                  <td className="logs-message">
                    {entry.message.trim() === '' ? (
                      <span className="logs-message-blank">(빈 줄)</span>
                    ) : (
                      entry.message
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
