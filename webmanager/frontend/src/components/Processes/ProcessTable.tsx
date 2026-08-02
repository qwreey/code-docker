import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { ProcessInfo } from '../../api/types'
import { formatBytes, formatPercent } from '../../utils/format'
import { ErrorBanner } from '../common/ErrorBanner'
import { KillButtons } from './KillButtons'
import './Processes.css'

const POLL_INTERVAL_MS = 4000

type SortKey = 'pid' | 'name' | 'username' | 'status' | 'cpuPercent' | 'memPercent' | 'rssBytes'
type SortDir = 'asc' | 'desc'

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'pid', label: 'PID' },
  { key: 'name', label: '이름' },
  { key: 'username', label: '사용자' },
  { key: 'status', label: '상태' },
  { key: 'cpuPercent', label: 'CPU' },
  { key: 'memPercent', label: 'MEM' },
  { key: 'rssBytes', label: 'RSS' },
]

const DESC_DEFAULT_KEYS: SortKey[] = ['cpuPercent', 'memPercent', 'rssBytes']

export function ProcessTable() {
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('cpuPercent')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const data = await api.get<ProcessInfo[]>('/processes')
      setProcesses(data)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(DESC_DEFAULT_KEYS.includes(key) ? 'desc' : 'asc')
    }
  }

  const sorted = [...processes].sort((a, b) => {
    const av = a[sortKey]
    const bv = b[sortKey]
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return sortDir === 'asc' ? cmp : -cmp
  })

  return (
    <div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <p className="empty-state">불러오는 중...</p>
      ) : sorted.length === 0 ? (
        <p className="empty-state">실행 중인 프로세스가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="process-info-table">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th key={col.key}>
                    <button type="button" className="sortable-header" onClick={() => toggleSort(col.key)}>
                      {col.label}
                      {sortKey === col.key && (
                        <span className="sort-indicator">{sortDir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </button>
                  </th>
                ))}
                <th>커맨드</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((proc) => (
                <tr key={proc.pid}>
                  <td>{proc.pid}</td>
                  <td>{proc.name}</td>
                  <td>{proc.username || '-'}</td>
                  <td>
                    <span className="badge badge-gray">{proc.status}</span>
                  </td>
                  <td>{formatPercent(proc.cpuPercent)}</td>
                  <td>{formatPercent(proc.memPercent)}</td>
                  <td>{formatBytes(proc.rssBytes)}</td>
                  <td className="process-cmdline" title={proc.cmdline}>
                    {proc.cmdline || '-'}
                  </td>
                  <td>
                    <KillButtons pid={proc.pid} label={proc.name} onKilled={load} onError={setError} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
