import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { ProcessInfo } from '../../api/types'
import { fuzzyMatch, type FuzzyMatchResult } from '../../utils/fuzzyMatch'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ProcessRowCells } from './ProcessRow'
import { ProcessTree } from './ProcessTree'
import './Processes.css'
import { withViewTransition } from '../../utils/viewTransition'

const POLL_INTERVAL_MS = 4000

type SortKey = 'pid' | 'name' | 'username' | 'status' | 'cpuPercent' | 'memPercent' | 'rssBytes'
type SortDir = 'asc' | 'desc'
type ViewMode = 'list' | 'tree'

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: 'pid', label: 'PID', className: 'pf-col-pid' },
  { key: 'name', label: '이름', className: 'pf-col-name' },
  { key: 'username', label: '사용자', className: 'pf-col-user' },
  { key: 'status', label: '상태', className: 'pf-col-status' },
  { key: 'cpuPercent', label: 'CPU', className: 'pf-col-cpu' },
  { key: 'memPercent', label: 'MEM', className: 'pf-col-mem' },
  { key: 'rssBytes', label: 'RSS', className: 'pf-col-rss' },
]

const DESC_DEFAULT_KEYS: SortKey[] = ['cpuPercent', 'memPercent', 'rssBytes']

const STATUS_LABELS: Record<string, string> = {
  running: '실행 중',
  sleeping: '대기(sleep)',
  sleep: '대기(sleep)',
  idle: '유휴',
  stop: '중지됨',
  stopped: '중지됨',
  zombie: '좀비',
  wait: '대기(wait)',
  lock: '잠김',
  blocked: '차단됨',
  disk_sleep: '디스크 대기',
}

const ALL_STATUS = '__all__'
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const
const ALL_PAGE_SIZE = '__all__'

interface ProcessMatch {
  nameMatch?: FuzzyMatchResult
  cmdMatch?: FuzzyMatchResult
}

export function ProcessTable() {
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('cpuPercent')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [statusFilter, setStatusFilter] = useState(ALL_STATUS)
  const [searchQuery, setSearchQuery] = useState('')
  const [pageSize, setPageSize] = useState<string>('25')
  const [page, setPage] = useState(1)

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
      withViewTransition(() => setLoading(false))
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  const availableStatuses = useMemo(() => {
    return Array.from(new Set(processes.map((p) => p.status))).sort()
  }, [processes])

  const statusFiltered = useMemo(
    () => (statusFilter === ALL_STATUS ? processes : processes.filter((p) => p.status === statusFilter)),
    [processes, statusFilter],
  )

  // Fuzzy-filter on process name/cmdline. Client-side, same reasoning as the
  // status filter above — process counts here are small and bounded, so
  // filtering on the server would be over-engineering.
  const { filtered, matches } = useMemo(() => {
    const query = searchQuery.trim()
    if (!query) return { filtered: statusFiltered, matches: undefined as Map<number, ProcessMatch> | undefined }

    const matchMap = new Map<number, ProcessMatch>()
    const result: ProcessInfo[] = []
    for (const proc of statusFiltered) {
      const nameMatch = fuzzyMatch(query, proc.name)
      const cmdMatch = fuzzyMatch(query, proc.cmdline || '')
      if (!nameMatch.matched && !cmdMatch.matched) continue
      matchMap.set(proc.pid, {
        nameMatch: nameMatch.matched ? nameMatch : undefined,
        cmdMatch: cmdMatch.matched ? cmdMatch : undefined,
      })
      result.push(proc)
    }
    return { filtered: result, matches: matchMap }
  }, [statusFiltered, searchQuery])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(DESC_DEFAULT_KEYS.includes(key) ? 'desc' : 'asc')
    }
  }

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        const av = a[sortKey]
        const bv = b[sortKey]
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
        return sortDir === 'asc' ? cmp : -cmp
      }),
    [filtered, sortKey, sortDir],
  )

  const pageSizeNum = pageSize === ALL_PAGE_SIZE ? sorted.length : Number(pageSize)
  const totalPages = pageSizeNum > 0 ? Math.max(1, Math.ceil(sorted.length / pageSizeNum)) : 1
  const clampedPage = Math.min(page, totalPages)

  useEffect(() => {
    setPage(1)
  }, [statusFilter, searchQuery, pageSize, viewMode])

  const paginated =
    pageSize === ALL_PAGE_SIZE ? sorted : sorted.slice((clampedPage - 1) * pageSizeNum, clampedPage * pageSizeNum)

  // DOM order for the visible rows is kept stable (pid ascending) across
  // polls, independent of the active sort — only the CSS `order` below
  // (rankByPid, driven by `sorted`'s position) moves rows visually. Sorting
  // by a value that fluctuates every poll (CPU/mem%) used to reshuffle
  // `paginated`'s own array order, which React reconciles by physically
  // moving <tr> DOM nodes even though their `key` (pid) didn't change - that
  // DOM movement is what was causing the reported scroll jump/reset, not an
  // explicit scroll reset anywhere. Rendering a pid-sorted copy instead means
  // React never needs to reorder nodes for the same set of rows; `order`
  // (see `.pf-col-*`/`process-flex-table` in Processes.css, which turns
  // tbody into a flex column container so `order` on each row takes effect)
  // repositions them visually with a pure CSS/compositor operation.
  const domOrdered = useMemo(() => [...paginated].sort((a, b) => a.pid - b.pid), [paginated])
  const rankByPid = useMemo(() => {
    const m = new Map<number, number>()
    paginated.forEach((p, i) => m.set(p.pid, i))
    return m
  }, [paginated])

  return (
    <div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="process-filters">
        <input
          type="search"
          className="process-search-input"
          placeholder="이름 또는 커맨드 검색..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="프로세스 검색"
        />
        <select
          className="process-status-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="상태 필터"
        >
          <option value={ALL_STATUS}>모든 상태</option>
          {availableStatuses.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s] ?? s}
            </option>
          ))}
        </select>
        <div className="processes-tabs processes-tabs-inline">
          <button
            type="button"
            className={`processes-tab${viewMode === 'list' ? ' processes-tab-active' : ''}`}
            onClick={() => setViewMode('list')}
          >
            목록
          </button>
          <button
            type="button"
            className={`processes-tab${viewMode === 'tree' ? ' processes-tab-active' : ''}`}
            onClick={() => setViewMode('tree')}
          >
            트리
          </button>
        </div>
      </div>

      {loading ? (
        <Skeleton />
      ) : sorted.length === 0 ? (
        <p className="empty-state">
          {processes.length === 0 ? '실행 중인 프로세스가 없습니다.' : '조건에 맞는 프로세스가 없습니다.'}
        </p>
      ) : (
        <>
          <div className="table-wrapper">
            <table className="process-info-table process-flex-table">
              <thead>
                <tr>
                  {COLUMNS.map((col) =>
                    viewMode === 'list' ? (
                      <th key={col.key} className={col.className}>
                        <button type="button" className="sortable-header" onClick={() => toggleSort(col.key)}>
                          {col.label}
                          {sortKey === col.key && (
                            <span className="sort-indicator">{sortDir === 'asc' ? '▲' : '▼'}</span>
                          )}
                        </button>
                      </th>
                    ) : (
                      <th key={col.key} className={col.className}>
                        {col.label}
                      </th>
                    ),
                  )}
                  <th className="pf-col-cmd">커맨드</th>
                  <th className="pf-col-actions" aria-label="동작">
                    &nbsp;
                  </th>
                </tr>
              </thead>
              {viewMode === 'list' ? (
                <tbody>
                  {domOrdered.map((proc) => (
                    <tr key={proc.pid} style={{ order: rankByPid.get(proc.pid) }}>
                      <ProcessRowCells
                        proc={proc}
                        nameMatch={matches?.get(proc.pid)?.nameMatch}
                        cmdMatch={matches?.get(proc.pid)?.cmdMatch}
                        onKilled={load}
                        onError={setError}
                      />
                    </tr>
                  ))}
                </tbody>
              ) : (
                <ProcessTree processes={sorted} matches={matches} onKilled={load} onError={setError} />
              )}
            </table>
          </div>

          {viewMode === 'list' && (
            <div className="process-pagination">
              <span className="process-pagination-info">
                총 {sorted.length}개 중 {sorted.length === 0 ? 0 : (clampedPage - 1) * pageSizeNum + 1}
                {'–'}
                {Math.min(sorted.length, clampedPage * pageSizeNum)}
              </span>
              <select
                className="process-pagesize-select"
                value={pageSize}
                onChange={(e) => setPageSize(e.target.value)}
                aria-label="페이지 크기"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}개씩
                  </option>
                ))}
                <option value={ALL_PAGE_SIZE}>전체</option>
              </select>
              <div className="process-pagination-controls">
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={clampedPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  이전
                </button>
                <span className="process-pagination-page">
                  {clampedPage} / {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={clampedPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  다음
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
