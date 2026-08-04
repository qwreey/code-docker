import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type {
  MiseEnvResponse,
  MiseJob,
  MiseJobStatus,
  MiseRecommendationCategory,
  MiseRecommendedTool,
  MiseToolEntry,
  MiseToolsResponse,
  RecommendationsResponse,
} from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import '../common/common.css'
import { JobPanel } from './JobPanel'
import './Mise.css'

const JOB_POLL_INTERVAL_MS = 800
const SHOW_RECOMMENDATIONS_KEY = 'webmanager.mise.showRecommendations'

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

interface JobState {
  jobId: string
  kind: 'install' | 'uninstall'
  toolId: string
  toolLabel: string
  status: MiseJobStatus | null
}

function keyFor(id: string, version: string): string {
  return `${id}@${version}`
}

export function Mise() {
  const [recommendations, setRecommendations] = useState<MiseRecommendationCategory[]>([])
  const [tools, setTools] = useState<MiseToolEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<JobState | null>(null)
  const [removeFromConfigChecked, setRemoveFromConfigChecked] = useState<Set<string>>(new Set())
  const [envData, setEnvData] = useState<Record<string, string> | null>(null)
  const [envLoading, setEnvLoading] = useState(false)
  const [envError, setEnvError] = useState<string | null>(null)
  const [categoryOpen, setCategoryOpen] = useState<Record<string, boolean>>({})
  const [showRecommendations, setShowRecommendations] = useState(loadShowRecommendations)

  const loadingRef = useRef(false)

  const busy = job !== null && (!job.status || job.status.running)

  const loadTools = useCallback(async () => {
    const res = await api.get<MiseToolsResponse>('/mise/tools')
    setTools(res.tools)
  }, [])

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const [recs] = await Promise.all([api.get<RecommendationsResponse>('/recommendations'), loadTools()])
      setRecommendations(recs.mise ?? [])
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [loadTools])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!job || (job.status && !job.status.running)) return
    let cancelled = false

    const poll = async () => {
      try {
        const status = await api.get<MiseJobStatus>(`/mise/jobs/${encodeURIComponent(job.jobId)}`)
        if (cancelled) return
        setJob((prev) => (prev && prev.jobId === job.jobId ? { ...prev, status } : prev))
        if (!status.running) {
          loadTools().catch((e) => {
            if (!cancelled) setError(errorMessage(e))
          })
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e))
      }
    }

    poll()
    const timer = setInterval(poll, JOB_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId, job?.status?.running])

  async function handleInstall(tool: MiseRecommendedTool) {
    if (busy) return
    setError(null)
    try {
      const res = await api.post<MiseJob>('/mise/tools', { id: tool.id, version: 'latest', global: true })
      setJob({ jobId: res.jobId, kind: 'install', toolId: tool.id, toolLabel: tool.label || tool.id, status: null })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function handleDelete(id: string, tool: MiseToolEntry) {
    if (busy) return
    const key = keyFor(id, tool.version)
    const removeFromConfig = removeFromConfigChecked.has(key)
    const confirmMessage = removeFromConfig
      ? `"${id}@${tool.version}"을(를) 삭제하고 설정 파일에서도 제거하시겠습니까?`
      : `"${id}@${tool.version}"을(를) 삭제하시겠습니까? (설정 파일의 항목은 유지됩니다)`
    if (!window.confirm(confirmMessage)) return
    setError(null)
    try {
      const res = await api.del<MiseJob>('/mise/tools', { id, version: tool.version, global: true, removeFromConfig })
      setJob({ jobId: res.jobId, kind: 'uninstall', toolId: id, toolLabel: `${id}@${tool.version}`, status: null })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function toggleRemoveFromConfig(key: string, checked: boolean) {
    setRemoveFromConfigChecked((prev) => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function toggleCategory(category: string) {
    setCategoryOpen((prev) => ({ ...prev, [category]: !isCategoryOpen(category, prev) }))
  }

  function isCategoryOpen(category: string, state: Record<string, boolean>): boolean {
    return state[category] ?? false
  }

  function handleShowRecommendationsChange(checked: boolean) {
    setShowRecommendations(checked)
    saveShowRecommendations(checked)
  }

  async function loadEnv() {
    setEnvLoading(true)
    setEnvError(null)
    try {
      const res = await api.get<MiseEnvResponse>('/mise/env')
      setEnvData(res.env)
    } catch (e) {
      setEnvError(errorMessage(e))
    } finally {
      setEnvLoading(false)
    }
  }

  const installedToolNames = new Set(tools.filter((t) => t.installed).map((t) => t.name))
  const envEntries = envData ? Object.entries(envData) : []

  return (
    <section>
      <div className="section-header">
        <h1>mise</h1>
        <div className="mise-header-controls">
          <label className="mise-recommend-toggle">
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
      <p className="section-description">
        mise로 관리하는 전역(global) 런타임/도구를 추천 목록에서 설치하거나 설치된 버전을 확인하고 삭제할 수 있습니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {job && (
        <JobPanel kind={job.kind} toolLabel={job.toolLabel} status={job.status} onClose={() => setJob(null)} />
      )}

      {showRecommendations && (
        <div className="mise-section">
          <h2>추천 도구 설치</h2>
          {loading && recommendations.length === 0 ? (
            <p className="empty-state">불러오는 중...</p>
          ) : recommendations.length === 0 ? (
            <p className="empty-state">추천 도구 목록이 없습니다.</p>
          ) : (
            recommendations.map((group) => {
              const isOpen = isCategoryOpen(group.category, categoryOpen)
              return (
                <div className="mise-group" key={group.category}>
                  <button
                    type="button"
                    className="mise-group-toggle"
                    onClick={() => toggleCategory(group.category)}
                    aria-expanded={isOpen}
                  >
                    <span className={`mise-chevron ${isOpen ? 'mise-chevron-open' : ''}`}>▶</span>
                    <h3 className="mise-group-title">{group.category}</h3>
                  </button>
                  {isOpen && (
                    <ul className="mise-list">
                      {group.tools.map((tool) => {
                        const installed = installedToolNames.has(tool.id)
                        const isThisJob = job?.toolId === tool.id && job.kind === 'install'
                        return (
                          <li className="mise-row" key={tool.id}>
                            <div className="mise-row-info">
                              <div className="mise-row-label">{tool.label || tool.id}</div>
                              {tool.description && <div className="mise-row-description">{tool.description}</div>}
                              <div className="mise-row-id">{tool.id}</div>
                            </div>
                            {installed ? (
                              <span className="badge badge-green">설치됨</span>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary btn-small"
                                onClick={() => handleInstall(tool)}
                                disabled={busy}
                              >
                                {isThisJob && busy ? '설치 중...' : '설치'}
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      <div className="mise-section">
        <h2>설치된 도구</h2>
        <p className="section-description">
          전역 mise 설정에 선언됐거나 실제로 설치된 도구입니다. &quot;활성&quot;은 그 버전이{' '}
          <code>mise use -g</code>로 전역 활성화됐다는 뜻이고, 활성 표시가 없는 항목은 설치는 돼 있지만 전역
          설정에는 반영되지 않은 버전입니다.
        </p>
        {loading && tools.length === 0 ? (
          <p className="empty-state">불러오는 중...</p>
        ) : tools.length === 0 ? (
          <p className="empty-state">전역으로 설치되거나 선언된 도구가 없습니다.</p>
        ) : (
          <div className="table-wrapper">
            <table className="process-info-table">
              <thead>
                <tr>
                  <th>도구</th>
                  <th>버전</th>
                  <th>요청 버전</th>
                  <th>상태</th>
                  <th aria-label="동작" />
                </tr>
              </thead>
              <tbody>
                {tools.map((tool) => {
                  const key = keyFor(tool.name, tool.version)
                  const checked = removeFromConfigChecked.has(key)
                  const isThisJob = job?.toolId === tool.name && job.kind === 'uninstall'
                  return (
                    <tr key={key}>
                      <td>{tool.name}</td>
                      <td className="mono-cell">{tool.version}</td>
                      <td className="mono-cell">{tool.requestedVersion}</td>
                      <td className="mise-status-badges">
                        {tool.installed ? (
                          <span className="badge badge-green">설치됨</span>
                        ) : (
                          <span className="badge badge-gray">미설치</span>
                        )}
                        {tool.active && <span className="badge badge-green">활성</span>}
                      </td>
                      <td>
                        <div className="mise-tool-actions">
                          <label className="mise-remove-config-toggle">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => toggleRemoveFromConfig(key, e.target.checked)}
                              disabled={busy}
                            />
                            설정에서도 제거
                          </label>
                          <button
                            type="button"
                            className="btn btn-danger btn-small"
                            disabled={busy}
                            onClick={() => handleDelete(tool.name, tool)}
                          >
                            {isThisJob && busy ? '삭제 중...' : '삭제'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mise-section">
        <h2>환경변수 미리보기</h2>
        <p className="section-description">
          전역 mise 환경(<code>mise env</code>)이 구성하는 환경변수를 확인합니다. API 키 등 민감한 값이 그대로
          노출될 수 있으니 화면 공유 시 주의하세요.
        </p>
        <button type="button" className="btn btn-secondary btn-small" onClick={loadEnv} disabled={envLoading}>
          {envLoading ? '불러오는 중...' : '환경변수 불러오기'}
        </button>
        {envError && <ErrorBanner message={envError} onDismiss={() => setEnvError(null)} />}
        {envData && (
          envEntries.length === 0 ? (
            <p className="empty-state">환경변수가 없습니다.</p>
          ) : (
            <div className="table-wrapper mise-env-table-wrapper">
              <table className="process-info-table">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>값</th>
                  </tr>
                </thead>
                <tbody>
                  {envEntries.map(([envKey, envValue]) => (
                    <tr key={envKey}>
                      <td className="mono-cell">{envKey}</td>
                      <td className="mono-cell mise-env-value">{envValue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </section>
  )
}
