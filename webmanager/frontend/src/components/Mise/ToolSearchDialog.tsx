import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { MiseRegistryEntry, MiseRegistrySearchResponse, MiseToolEntry, MiseVersionsResponse } from '../../api/types'
import { ErrorBanner } from '@code-docker/router-frontend'
import '../common/common.css'
import './Mise.css'

const MIN_QUERY_LEN = 2
const SEARCH_RESULT_LIMIT = 50
const VERSION_RENDER_LIMIT = 300

interface ToolSearchDialogProps {
  open: boolean
  onClose: () => void
  // Already-installed tools (Mise.tsx's own `tools` state) - reused here
  // only to mark which remote versions of the currently-viewed tool are
  // already installed, not re-fetched.
  installedTools: MiseToolEntry[]
  // Starts an install job and closes this dialog - Mise.tsx owns the
  // actual job state/JobDialog, this component just triggers it.
  onInstall: (id: string, version: string, label: string) => void
}

export function ToolSearchDialog({ open, onClose, installedTools, onInstall }: ToolSearchDialogProps) {
  const [query, setQuery] = useState('')
  const [queryError, setQueryError] = useState<string | null>(null)
  const [results, setResults] = useState<MiseRegistryEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [selectedTool, setSelectedTool] = useState<MiseRegistryEntry | null>(null)
  const [versions, setVersions] = useState<string[] | null>(null)
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [versionFilter, setVersionFilter] = useState('')

  useEffect(() => {
    if (!open) return
    setQuery('')
    setQueryError(null)
    setResults(null)
    setSearchError(null)
    setSelectedTool(null)
    setVersions(null)
    setVersionsError(null)
    setVersionFilter('')
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  async function runSearch(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = query.trim()
    if ([...trimmed].length < MIN_QUERY_LEN) {
      setQueryError(`검색어는 ${MIN_QUERY_LEN}글자 이상 입력하세요.`)
      setResults(null)
      return
    }
    setQueryError(null)
    setSearchError(null)
    setSearching(true)
    try {
      const res = await api.get<MiseRegistrySearchResponse>(`/mise/registry/search?q=${encodeURIComponent(trimmed)}`)
      setResults(res.entries)
    } catch (e) {
      setSearchError(errorMessage(e))
      setResults(null)
    } finally {
      setSearching(false)
    }
  }

  async function openVersions(entry: MiseRegistryEntry) {
    setSelectedTool(entry)
    setVersions(null)
    setVersionsError(null)
    setVersionFilter('')
    setVersionsLoading(true)
    try {
      const res = await api.get<MiseVersionsResponse>(`/mise/versions?id=${encodeURIComponent(entry.short)}`)
      setVersions([...res.versions].reverse())
    } catch (e) {
      setVersionsError(errorMessage(e))
    } finally {
      setVersionsLoading(false)
    }
  }

  function backToSearch() {
    setSelectedTool(null)
    setVersions(null)
    setVersionsError(null)
  }

  function handleQuickInstall(entry: MiseRegistryEntry) {
    onInstall(entry.short, 'latest', entry.short)
    onClose()
  }

  function handleInstallVersion(version: string) {
    if (!selectedTool) return
    onInstall(selectedTool.short, version, `${selectedTool.short}@${version}`)
    onClose()
  }

  const installedVersions =
    selectedTool !== null
      ? new Set(installedTools.filter((t) => t.name === selectedTool.short).map((t) => t.version))
      : new Set<string>()

  const filteredVersions = (versions ?? []).filter((v) => v.includes(versionFilter.trim()))
  const shownVersions = filteredVersions.slice(0, VERSION_RENDER_LIMIT)
  const shownResults = (results ?? []).slice(0, SEARCH_RESULT_LIMIT)

  return (
    <div className="mise-search-dialog-backdrop" onClick={onClose}>
      <div
        className="card mise-search-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label="도구 검색"
        onClick={(e) => e.stopPropagation()}
      >
        {selectedTool === null ? (
          <>
            <div className="mise-search-dialog-header">
              <h2>도구 검색</h2>
              <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
                닫기
              </button>
            </div>
            <form className="mise-search-form" onSubmit={runSearch}>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="도구 이름 검색 (예: node, ripgrep, jq)"
                autoFocus
              />
              <button type="submit" className="btn btn-primary btn-small" disabled={searching}>
                {searching ? '검색 중...' : '검색'}
              </button>
            </form>
            {queryError && <p className="mise-search-hint">{queryError}</p>}
            {searchError && <ErrorBanner message={searchError} onDismiss={() => setSearchError(null)} />}
            {results !== null && results.length > SEARCH_RESULT_LIMIT && (
              <p className="mise-search-hint">
                {results.length}개 일치 - 상위 {SEARCH_RESULT_LIMIT}개만 표시합니다. 검색어를 구체화해 보세요.
              </p>
            )}
            <div className="mise-search-results">
              {results !== null && results.length === 0 && <p className="empty-state">일치하는 도구가 없습니다.</p>}
              {shownResults.map((entry) => (
                <div className="mise-search-result-row" key={entry.short}>
                  <div className="mise-row-info">
                    <div className="mise-row-label">{entry.short}</div>
                    {entry.description && <div className="mise-row-description">{entry.description}</div>}
                    <div className="mise-search-result-backends">
                      {entry.backends.map((b) => (
                        <span className="badge badge-gray" key={b}>
                          {b}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="mise-search-result-actions">
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => openVersions(entry)}>
                      버전 보기
                    </button>
                    <button type="button" className="btn btn-primary btn-small" onClick={() => handleQuickInstall(entry)}>
                      설치
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="mise-version-back">
              <button type="button" className="btn btn-secondary btn-small" onClick={backToSearch}>
                ← 검색 결과로
              </button>
              <h2>{selectedTool.short} 버전 선택</h2>
            </div>
            <div className="mise-search-form">
              <input
                type="text"
                value={versionFilter}
                onChange={(e) => setVersionFilter(e.target.value)}
                placeholder="버전 필터 (예: 20, 3.12)"
              />
            </div>
            {versionsError && <ErrorBanner message={versionsError} onDismiss={() => setVersionsError(null)} />}
            {versionsLoading ? (
              <p className="empty-state">버전 목록을 불러오는 중...</p>
            ) : (
              <>
                {filteredVersions.length > VERSION_RENDER_LIMIT && (
                  <p className="mise-search-hint">
                    {filteredVersions.length}개 중 최신 {VERSION_RENDER_LIMIT}개만 표시합니다. 필터로 좁혀보세요.
                  </p>
                )}
                <div className="mise-version-list">
                  {filteredVersions.length === 0 && <p className="empty-state">일치하는 버전이 없습니다.</p>}
                  {shownVersions.map((version) => (
                    <div className="mise-version-row" key={version}>
                      <span>{version}</span>
                      {installedVersions.has(version) ? (
                        <span className="badge badge-green">설치됨</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-small"
                          onClick={() => handleInstallVersion(version)}
                        >
                          설치
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
