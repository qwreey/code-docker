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
import { ConfirmDialog } from '../common/ConfirmDialog'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { RestartNeededBanner } from '../common/RestartNeededBanner'
import '../common/common.css'
import { JobDialog } from './JobDialog'
import { JobPanel } from './JobPanel'
import { ToolSearchDialog } from './ToolSearchDialog'
import './Mise.css'
import { withViewTransition } from '../../utils/viewTransition'

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
  action?: 'deactivate' | 'reactivate'
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
  const [removeFromConfigOnDelete, setRemoveFromConfigOnDelete] = useState(false)
  const [envData, setEnvData] = useState<Record<string, string> | null>(null)
  const [envLoading, setEnvLoading] = useState(false)
  const [envError, setEnvError] = useState<string | null>(null)
  const [categoryOpen, setCategoryOpen] = useState<Record<string, boolean>>({})
  const [showRecommendations, setShowRecommendations] = useState(loadShowRecommendations)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; tool: MiseToolEntry } | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<{ id: string; tool: MiseToolEntry } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

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
      withViewTransition(() => setLoading(false))
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

  // Shared by the recommendation list's install button and
  // ToolSearchDialog's quick-install/version-picker install buttons - both
  // just resolve an id+version and hand off to the same job machinery.
  const installTool = useCallback(
    async (id: string, version: string, label: string) => {
      if (busy) return
      setError(null)
      try {
        const res = await api.post<MiseJob>('/mise/tools', { id, version, global: true })
        setJob({ jobId: res.jobId, kind: 'install', toolId: id, toolLabel: label, status: null })
      } catch (e) {
        setError(errorMessage(e))
      }
    },
    [busy],
  )

  function handleInstall(tool: MiseRecommendedTool) {
    installTool(tool.id, 'latest', tool.label || tool.id)
  }

  function handleDelete(id: string, tool: MiseToolEntry) {
    if (busy) return
    setRemoveFromConfigOnDelete(false)
    setDeleteTarget({ id, tool })
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    const { id, tool } = deleteTarget
    const removeFromConfig = removeFromConfigOnDelete
    setDeleteTarget(null)
    setError(null)
    try {
      const res = await api.del<MiseJob>('/mise/tools', { id, version: tool.version, global: true, removeFromConfig })
      setJob({ jobId: res.jobId, kind: 'uninstall', toolId: id, toolLabel: `${id}@${tool.version}`, status: null })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function handleDeactivate(id: string, tool: MiseToolEntry) {
    if (busy) return
    setDeactivateTarget({ id, tool })
  }

  async function confirmDeactivate() {
    if (!deactivateTarget) return
    const { id, tool } = deactivateTarget
    setDeactivateTarget(null)
    setError(null)
    try {
      const res = await api.del<MiseJob>('/mise/tools', { id, version: tool.version, global: true, configOnly: true })
      setJob({
        jobId: res.jobId,
        kind: 'uninstall',
        action: 'deactivate',
        toolId: id,
        toolLabel: `${id}@${tool.version}`,
        status: null,
      })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function handleReactivate(id: string, tool: MiseToolEntry) {
    if (busy) return
    setError(null)
    try {
      const res = await api.post<MiseJob>('/mise/tools', { id, version: tool.version, global: true })
      setJob({
        jobId: res.jobId,
        kind: 'install',
        action: 'reactivate',
        toolId: id,
        toolLabel: `${id}@${tool.version}`,
        status: null,
      })
    } catch (e) {
      setError(errorMessage(e))
    }
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
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setSearchOpen(true)}>
            도구 검색
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
            {loading ? '불러오는 중...' : '새로고침'}
          </button>
        </div>
      </div>
      <p className="section-description">
        mise로 관리하는 전역(global) 런타임/도구를 추천 목록에서 설치하거나, 도구 검색으로 임의 도구/버전을 찾아
        설치할 수 있습니다. 설치된 버전은 확인하고 삭제할 수 있습니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <RestartNeededBanner refreshToken={job ? `${job.jobId}:${job.status?.running}` : undefined} />

      {job && (
        <JobDialog>
          <JobPanel
            kind={job.kind}
            toolLabel={job.toolLabel}
            status={job.status}
            onClose={() => setJob(null)}
            actionLabel={job.action === 'deactivate' ? '비활성화' : job.action === 'reactivate' ? '재활성화' : undefined}
          />
        </JobDialog>
      )}

      <ToolSearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        installedTools={tools}
        onInstall={installTool}
      />

      {showRecommendations && (
        <div className="mise-section">
          <h2>추천 도구 설치</h2>
          {loading && recommendations.length === 0 ? (
            <Skeleton />
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
          <Skeleton />
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
                  const isDeleteJob = job?.toolId === tool.name && job.kind === 'uninstall' && job.action !== 'deactivate'
                  const isDeactivateJob = job?.toolId === tool.name && job.action === 'deactivate'
                  const isReactivateJob = job?.toolId === tool.name && job.action === 'reactivate'
                  const declared = tool.source !== null
                  return (
                    <tr key={key}>
                      <td>{tool.name}</td>
                      <td className="mono-cell">{tool.version}</td>
                      <td className="mono-cell">{tool.requestedVersion}</td>
                      <td>
                        <div className="mise-status-badges">
                          {tool.installed ? (
                            <span className="badge badge-green">설치됨</span>
                          ) : (
                            <span className="badge badge-gray">미설치</span>
                          )}
                          {tool.active && <span className="badge badge-green">활성</span>}
                        </div>
                      </td>
                      <td>
                        <div className="mise-tool-actions">
                          {declared && tool.installed && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-small"
                              disabled={busy}
                              onClick={() => handleDeactivate(tool.name, tool)}
                            >
                              {isDeactivateJob && busy ? '비활성화 중...' : '비활성화'}
                            </button>
                          )}
                          {!declared && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-small"
                              disabled={busy}
                              onClick={() => handleReactivate(tool.name, tool)}
                            >
                              {isReactivateJob && busy ? '재활성화 중...' : '재활성화'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-danger btn-small"
                            disabled={busy}
                            onClick={() => handleDelete(tool.name, tool)}
                          >
                            {isDeleteJob && busy ? '삭제 중...' : '삭제'}
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

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="도구 삭제"
        confirmLabel="삭제"
      >
        {deleteTarget && (
          <>
            {removeFromConfigOnDelete ? (
              <>
                &quot;{deleteTarget.id}@{deleteTarget.tool.version}&quot;을(를) 삭제하고 설정 파일에서도 제거하시겠습니까?
              </>
            ) : (
              <>
                &quot;{deleteTarget.id}@{deleteTarget.tool.version}&quot;을(를) 삭제하시겠습니까? (설정 파일의 항목은
                유지됩니다)
              </>
            )}
            <label className="confirm-dialog-checkbox">
              <input
                type="checkbox"
                checked={removeFromConfigOnDelete}
                onChange={(e) => setRemoveFromConfigOnDelete(e.target.checked)}
              />
              설정에서도 제거
            </label>
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={deactivateTarget !== null}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={confirmDeactivate}
        title="도구 비활성화"
        confirmLabel="비활성화"
      >
        {deactivateTarget && (
          <>
            &quot;{deactivateTarget.id}@{deactivateTarget.tool.version}&quot;을(를) 전역 설정에서 비활성화하시겠습니까?
            설치된 바이너리는 그대로 유지되고, 다시 필요할 때 재활성화할 수 있습니다.
          </>
        )}
      </ConfirmDialog>
    </section>
  )
}
