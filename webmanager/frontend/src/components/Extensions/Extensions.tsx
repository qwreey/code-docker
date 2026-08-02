import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { CodeExtensionsResponse, RecommendationsResponse, RecommendedExtension } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import '../common/common.css'
import './Extensions.css'

const SHOW_RECOMMENDATIONS_KEY = 'webmanager.extensions.showRecommendations'

// Every extension id is publisher.name, so the open-vsx page URL is always
// constructible without a lookup — code-server only installs from open-vsx
// (not the MS marketplace), so this is the one registry link that's always
// safe to build client-side (see .claude/extension-search-plan.md for why a
// GitHub/homepage link isn't similarly derivable).
function openVsxUrl(id: string): string | null {
  const dot = id.indexOf('.')
  if (dot <= 0 || dot === id.length - 1) return null
  return `https://open-vsx.org/extension/${encodeURIComponent(id.slice(0, dot))}/${encodeURIComponent(id.slice(dot + 1))}`
}

function loadShowRecommendations(): boolean {
  try {
    const stored = localStorage.getItem(SHOW_RECOMMENDATIONS_KEY)
    if (stored === null) return true
    return stored === 'true'
  } catch {
    return true
  }
}

function saveShowRecommendations(value: boolean) {
  try {
    localStorage.setItem(SHOW_RECOMMENDATIONS_KEY, value ? 'true' : 'false')
  } catch {
    // localStorage unavailable (e.g. private browsing) - preference just won't persist
  }
}

export function Extensions() {
  const [extensions, setExtensions] = useState<RecommendedExtension[]>([])
  const [installedList, setInstalledList] = useState<string[]>([])
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installedSectionOpen, setInstalledSectionOpen] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState<Record<string, boolean>>({})
  const [showRecommendations, setShowRecommendations] = useState(loadShowRecommendations)

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const [recommendations, codeExtensions] = await Promise.all([
        api.get<RecommendationsResponse>('/recommendations'),
        api.get<CodeExtensionsResponse>('/code-extensions'),
      ])
      setExtensions(recommendations.extensions)
      setInstalledList(codeExtensions.installed)
      setInstalled(new Set(codeExtensions.installed))
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
  }, [load])

  const groups: { category: string; items: RecommendedExtension[] }[] = []
  const groupIndex = new Map<string, number>()
  for (const ext of extensions) {
    const category = ext.category
    let idx = groupIndex.get(category)
    if (idx === undefined) {
      idx = groups.length
      groupIndex.set(category, idx)
      groups.push({ category, items: [] })
    }
    groups[idx].items.push(ext)
  }
  const otherIdx = groups.findIndex((g) => g.category === '')
  if (otherIdx !== -1 && otherIdx !== groups.length - 1) {
    const [other] = groups.splice(otherIdx, 1)
    groups.push(other)
  }

  async function handleInstall(id: string) {
    setInstallingId(id)
    try {
      await api.post<{ ok: true }>('/code-extensions', { id })
      setInstalled((prev) => new Set(prev).add(id))
      setInstalledList((prev) => (prev.includes(id) ? prev : [...prev, id]))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setInstallingId(null)
    }
  }

  function toggleCategory(category: string) {
    setCategoryOpen((prev) => ({ ...prev, [category]: !isCategoryOpen(category, prev) }))
  }

  function isCategoryOpen(category: string, state: Record<string, boolean>): boolean {
    return state[category] ?? true
  }

  function handleShowRecommendationsChange(checked: boolean) {
    setShowRecommendations(checked)
    saveShowRecommendations(checked)
  }

  return (
    <section>
      <div className="section-header">
        <h1>Code Extensions</h1>
        <div className="extensions-header-controls">
          <label className="extensions-recommend-toggle">
            <input
              type="checkbox"
              checked={showRecommendations}
              onChange={(e) => handleShowRecommendationsChange(e.target.checked)}
            />
            추천 표시
          </label>
          <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
            {loading ? '불러오는 중...' : '새로고침'}
          </button>
        </div>
      </div>
      <p className="section-description">추천 code-server 익스텐션을 확인하고 바로 설치할 수 있습니다.</p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="extensions-group">
        <button
          type="button"
          className="extensions-group-toggle"
          onClick={() => setInstalledSectionOpen((prev) => !prev)}
          aria-expanded={installedSectionOpen}
        >
          <span className={`extensions-chevron ${installedSectionOpen ? 'extensions-chevron-open' : ''}`}>▶</span>
          <h2 className="extensions-group-title">설치된 익스텐션 ({installedList.length}개)</h2>
        </button>
        {installedSectionOpen &&
          (installedList.length === 0 ? (
            <p className="empty-state">설치된 익스텐션이 없습니다.</p>
          ) : (
            <ul className="extensions-list">
              {installedList.map((id) => (
                <li className="extensions-row" key={id}>
                  <div className="extensions-row-info">
                    <div className="extensions-row-id">
                      {id}
                      {openVsxUrl(id) && (
                        <a
                          className="extensions-more-link"
                          href={openVsxUrl(id)!}
                          target="_blank"
                          rel="noreferrer"
                        >
                          open-vsx ↗
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ))}
      </div>

      {showRecommendations &&
        (loading && extensions.length === 0 ? (
          <p className="empty-state">불러오는 중...</p>
        ) : extensions.length === 0 ? (
          <p className="empty-state">추천 익스텐션 목록이 없습니다.</p>
        ) : (
          <>
            {groups.map((group) => {
              const isOpen = isCategoryOpen(group.category, categoryOpen)
              return (
                <div className="extensions-group" key={group.category || '기타'}>
                  <button
                    type="button"
                    className="extensions-group-toggle"
                    onClick={() => toggleCategory(group.category)}
                    aria-expanded={isOpen}
                  >
                    <span className={`extensions-chevron ${isOpen ? 'extensions-chevron-open' : ''}`}>▶</span>
                    <h2 className="extensions-group-title">{group.category || '기타'}</h2>
                  </button>
                  {isOpen && (
                    <ul className="extensions-list">
                      {group.items.map((ext) => {
                        const isInstalled = installed.has(ext.id)
                        const isInstalling = installingId === ext.id
                        return (
                          <li className="extensions-row" key={ext.id}>
                            <div className="extensions-row-info">
                              <div className="extensions-row-label">{ext.label}</div>
                              <div className="extensions-row-description">{ext.description}</div>
                              <div className="extensions-row-id">
                                {ext.id}
                                {openVsxUrl(ext.id) && (
                                  <a
                                    className="extensions-more-link"
                                    href={openVsxUrl(ext.id)!}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    open-vsx ↗
                                  </a>
                                )}
                              </div>
                            </div>
                            {isInstalled ? (
                              <span className="badge badge-green">설치됨</span>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary btn-small"
                                onClick={() => handleInstall(ext.id)}
                                disabled={isInstalling}
                              >
                                {isInstalling ? '설치 중...' : '설치'}
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}
            <p className="extensions-note">설치 후 변경 사항을 code-server에 반영하려면 재시작이 필요할 수 있습니다.</p>
          </>
        ))}
    </section>
  )
}
