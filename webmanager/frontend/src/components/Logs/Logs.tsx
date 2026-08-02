import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type {
  LogEntriesResponse,
  LogEntry,
  LogLevel,
  LogsAppsResponse,
  LogsRangeResponse,
} from '../../api/types'
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

// Entries fetched per page (initial load and each "더 보기" click).
const PAGE_SIZE = 150
// Hard cap on entries kept in state/rendered — once "더 보기" pushes past
// this, the oldest-loaded entries are dropped so the table's DOM can't grow
// unbounded.
const MAX_ENTRIES = 2000
const POLL_INTERVAL_MS = 5000

function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromDatetimeLocalValue(value: string): number | undefined {
  if (!value) return undefined
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

export function Logs() {
  const [apps, setApps] = useState<string[]>([])
  const [selectedApp, setSelectedApp] = useState('')
  const [level, setLevel] = useState<'all' | LogLevel>('all')
  const [range, setRange] = useState<LogsRangeResponse | null>(null)
  const [startMs, setStartMs] = useState<number | undefined>(undefined)
  const [endMs, setEndMs] = useState<number | undefined>(undefined)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [mock, setMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [liveRefresh, setLiveRefresh] = useState(false)

  const loadingRef = useRef(false)
  // Mirrors `entries` so loadNewEntries (the live-refresh poller) can read
  // the current newest timestamp without depending on `entries` itself —
  // keeping its identity stable across ticks that don't change the list, so
  // the polling interval effect doesn't get torn down and rebuilt every 5s.
  const entriesRef = useRef<LogEntry[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all([api.get<LogsAppsResponse>('/logs/apps'), api.get<LogsRangeResponse>('/logs/range')])
      .then(([appsData, rangeData]) => {
        if (cancelled) return
        setApps(appsData.apps)
        setMock((prev) => prev || appsData.mock)
        setRange(rangeData)
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const noData = range !== null && range.earliest === null && range.latest === null

  const buildParams = useCallback(
    // `before`: pagination cursor for "더 보기" (strictly older than this).
    // `startOverride`: used by live-refresh to ask for "newer than this
    // timestamp" without touching the startMs filter state/input.
    (before?: number, startOverride?: number) => {
      const params = new URLSearchParams()
      if (selectedApp) params.set('app', selectedApp)
      if (level !== 'all') params.set('level', level)
      params.set('limit', String(PAGE_SIZE))
      const start = startOverride ?? startMs
      if (start != null) params.set('start', String(start))
      if (endMs != null) params.set('end', String(endMs))
      if (before != null) params.set('before', String(before))
      return params
    },
    [selectedApp, level, startMs, endMs],
  )

  // Loads (or reloads) the first page — used on mount, on filter change, and
  // by live-refresh. Always replaces the loaded set, which is also how
  // filter changes and live refresh naturally reset pagination.
  const loadFirstPage = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const data = await api.get<LogEntriesResponse>(`/logs/entries?${buildParams().toString()}`)
      setEntries(data.entries)
      setHasMore(data.hasMore)
      setMock((prev) => prev || data.mock)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [buildParams])

  useEffect(() => {
    loadFirstPage()
  }, [loadFirstPage])

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  // Live-refresh tick: fetches only entries newer than the newest one
  // already held (via `start`, since the backend has no dedicated
  // "strictly newer than" cursor) and prepends them, instead of replacing
  // the loaded set — so scroll position and "더 보기"-loaded history survive
  // a live session. `start` is inclusive, so the already-held newest entry
  // can come back in the response; filter it (and anything else not
  // actually newer) out client-side before merging.
  const loadNewEntries = useCallback(async () => {
    if (loadingRef.current) return
    const current = entriesRef.current
    if (current.length === 0) return
    loadingRef.current = true
    try {
      const newest = current[0].timestamp
      const data = await api.get<LogEntriesResponse>(`/logs/entries?${buildParams(undefined, newest).toString()}`)
      const fresh = data.entries.filter((e) => e.timestamp > newest)
      if (fresh.length > 0) {
        setEntries((prev) => {
          const combined = [...fresh, ...prev]
          return combined.length > MAX_ENTRIES ? combined.slice(0, MAX_ENTRIES) : combined
        })
      }
      setMock((prev) => prev || data.mock)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      loadingRef.current = false
    }
  }, [buildParams])

  useEffect(() => {
    if (!liveRefresh) return
    const timer = setInterval(loadNewEntries, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [liveRefresh, loadNewEntries])

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || loading || entries.length === 0) return
    setLoadingMore(true)
    try {
      const before = entries[entries.length - 1].timestamp
      const data = await api.get<LogEntriesResponse>(`/logs/entries?${buildParams(before).toString()}`)
      setEntries((prev) => {
        const combined = [...prev, ...data.entries]
        return combined.length > MAX_ENTRIES ? combined.slice(0, MAX_ENTRIES) : combined
      })
      setHasMore(data.hasMore)
      setMock((prev) => prev || data.mock)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoadingMore(false)
    }
  }, [entries, loadingMore, loading, buildParams])

  const handleAllTime = () => {
    setStartMs(undefined)
    setEndMs(undefined)
  }

  const rangeMin = range?.earliest != null ? toDatetimeLocalValue(range.earliest) : undefined
  const rangeMax = range?.latest != null ? toDatetimeLocalValue(range.latest) : undefined

  return (
    <section>
      <div className="section-header">
        <h1>Logs</h1>
        <button type="button" className="btn btn-secondary btn-small" onClick={loadFirstPage} disabled={loading}>
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

      {noData ? (
        <p className="empty-state">로그가 없습니다.</p>
      ) : (
        <>
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
            <div className="form-field">
              <label htmlFor="logs-start">시작 시각</label>
              <input
                id="logs-start"
                type="datetime-local"
                value={startMs != null ? toDatetimeLocalValue(startMs) : ''}
                min={rangeMin}
                max={rangeMax}
                disabled={!range || liveRefresh}
                onChange={(e) => setStartMs(fromDatetimeLocalValue(e.target.value))}
              />
            </div>
            <div className="form-field">
              <label htmlFor="logs-end">종료 시각</label>
              <input
                id="logs-end"
                type="datetime-local"
                value={endMs != null ? toDatetimeLocalValue(endMs) : ''}
                min={rangeMin}
                max={rangeMax}
                disabled={!range || liveRefresh}
                onChange={(e) => setEndMs(fromDatetimeLocalValue(e.target.value))}
              />
            </div>
            <div className="form-field">
              <label htmlFor="logs-all-time">&nbsp;</label>
              <button
                id="logs-all-time"
                type="button"
                className="btn btn-secondary btn-small"
                disabled={liveRefresh || (startMs == null && endMs == null)}
                onClick={handleAllTime}
              >
                전체 기간
              </button>
            </div>
            <label className="logs-live-toggle">
              <input
                type="checkbox"
                checked={liveRefresh}
                onChange={(e) => {
                  const checked = e.target.checked
                  setLiveRefresh(checked)
                  // A fixed date range and "always show the newest" don't
                  // make sense together — drop it when live mode turns on.
                  if (checked) handleAllTime()
                }}
              />
              실시간 새로고침
            </label>
          </div>

          {entries.length === 0 ? (
            <p className="empty-state">로그가 없습니다.</p>
          ) : (
            <>
              <div className="table-wrapper logs-table-wrapper">
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
              {hasMore && (
                <div className="logs-load-more">
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? '불러오는 중...' : '더 보기'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
