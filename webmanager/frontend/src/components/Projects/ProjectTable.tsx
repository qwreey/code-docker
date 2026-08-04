import { Fragment, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { MiseToolEntry, MiseToolsResponse, ProjectInfo } from '../../api/types'
import { formatBytes } from '../../utils/format'
import './Projects.css'

const STALE_AFTER_MS = 60 * 60 * 1000

type SortKey = 'lastModified' | 'totalSizeBytes'
type SortDir = 'asc' | 'desc'

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'lastModified', label: '최근 수정' },
  { key: 'totalSizeBytes', label: '총 용량' },
]

function isStale(scannedAt: string): boolean {
  return Date.now() - new Date(scannedAt).getTime() > STALE_AFTER_MS
}

export function ProjectTable({
  projects,
  codeServerUrl,
  onProjectUpdated,
  onError,
}: {
  projects: ProjectInfo[]
  codeServerUrl: string
  onProjectUpdated: (project: ProjectInfo) => void
  onError: (message: string) => void
}) {
  const [sortKey, setSortKey] = useState<SortKey>('lastModified')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [rescanning, setRescanning] = useState<Set<string>>(new Set())
  const [miseTools, setMiseTools] = useState<Map<string, MiseToolEntry[]>>(new Map())
  const [miseLoading, setMiseLoading] = useState<Set<string>>(new Set())

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  async function rescanProject(path: string) {
    setRescanning((prev) => new Set(prev).add(path))
    try {
      const updated = await api.post<ProjectInfo>(`/projects/rescan?path=${encodeURIComponent(path)}`)
      onProjectUpdated(updated)
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setRescanning((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }

  async function loadMiseTools(path: string) {
    if (miseTools.has(path) || miseLoading.has(path)) return
    setMiseLoading((prev) => new Set(prev).add(path))
    try {
      const res = await api.get<MiseToolsResponse>(`/mise/tools?path=${encodeURIComponent(path)}`)
      setMiseTools((prev) => new Map(prev).set(path, res.tools))
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setMiseLoading((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }

  function toggleExpand(project: ProjectInfo) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(project.path)) {
        next.delete(project.path)
      } else {
        next.add(project.path)
        if (isStale(project.scannedAt)) {
          rescanProject(project.path)
        }
        loadMiseTools(project.path)
      }
      return next
    })
  }

  function openInCodeServer(e: React.MouseEvent, path: string) {
    e.stopPropagation()
    window.open(`${codeServerUrl}/?folder=${encodeURIComponent(path)}`, '_blank')
  }

  const sorted = [...projects].sort((a, b) => {
    const cmp =
      sortKey === 'totalSizeBytes'
        ? a.totalSizeBytes - b.totalSizeBytes
        : new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime()
    return sortDir === 'asc' ? cmp : -cmp
  })

  if (sorted.length === 0) {
    return <p className="empty-state">프로젝트가 없습니다.</p>
  }

  return (
    <div className="table-wrapper">
      <table className="process-info-table projects-table">
        <thead>
          <tr>
            <th aria-label="펼치기" />
            <th>이름</th>
            {COLUMNS.map((col) => (
              <th key={col.key}>
                <button type="button" className="sortable-header" onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sortKey === col.key && <span className="sort-indicator">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                </button>
              </th>
            ))}
            <th>기술 스택</th>
            <th>상태</th>
            <th aria-label="동작" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((project) => {
            const isExpanded = expanded.has(project.path)
            const isRescanning = rescanning.has(project.path)
            return (
              <Fragment key={project.path}>
                <tr
                  className="projects-row"
                  onClick={() => toggleExpand(project)}
                >
                  <td className="projects-expand-cell">{isExpanded ? '▼' : '▶'}</td>
                  <td>
                    <div>{project.name}</div>
                    <div className="projects-path">{project.path}</div>
                  </td>
                  <td>{new Date(project.lastModified).toLocaleString()}</td>
                  <td>{formatBytes(project.totalSizeBytes)}</td>
                  <td>
                    {project.techStack.length === 0 ? (
                      <span className="projects-no-badge">-</span>
                    ) : (
                      project.techStack.map((tech) => (
                        <span key={tech} className="badge badge-gray projects-tech-badge">
                          {tech}
                        </span>
                      ))
                    )}
                  </td>
                  <td>{project.stale && <span className="badge badge-yellow">오래됨</span>}</td>
                  <td>
                    <div className="projects-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={isRescanning}
                        onClick={(e) => {
                          e.stopPropagation()
                          rescanProject(project.path)
                        }}
                      >
                        {isRescanning ? '갱신 중...' : '새로고침'}
                      </button>
                      {codeServerUrl && (
                        <button
                          type="button"
                          className="btn btn-primary btn-small"
                          onClick={(e) => openInCodeServer(e, project.path)}
                        >
                          code-server에서 열기
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="projects-detail-row">
                    <td colSpan={7}>
                      <div className="projects-detail">
                        <div className="projects-detail-header">
                          재생성 가능 폴더 합계: {formatBytes(project.reclaimableSizeBytes)}
                          {' · '}
                          마지막 스캔: {new Date(project.scannedAt).toLocaleString()}
                        </div>
                        {project.reclaimable.length === 0 ? (
                          <p className="empty-state">재생성 가능한 폴더가 없습니다.</p>
                        ) : (
                          <table className="projects-reclaimable-table">
                            <thead>
                              <tr>
                                <th>패턴</th>
                                <th>경로</th>
                                <th>용량</th>
                              </tr>
                            </thead>
                            <tbody>
                              {project.reclaimable.map((entry) => (
                                <tr key={entry.path}>
                                  <td>
                                    <span className="badge badge-gray">{entry.pattern}</span>
                                  </td>
                                  <td className="mono-cell">{entry.path}</td>
                                  <td>{formatBytes(entry.sizeBytes)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {(() => {
                          const entries = miseTools.get(project.path) ?? []
                          if (miseLoading.has(project.path)) {
                            return <p className="empty-state projects-mise-loading">mise 도구 확인 중...</p>
                          }
                          if (entries.length === 0) return null
                          return (
                            <div className="projects-mise-section">
                              <div className="projects-detail-header">이 프로젝트가 쓰는 도구</div>
                              <ul className="projects-mise-list">
                                {entries.map((tool) => (
                                  <li key={`${tool.name}@${tool.version}`} className="projects-mise-row">
                                    <span className="projects-mise-id">{tool.name}</span>
                                    <span className="mono-cell">{tool.version}</span>
                                    {tool.installed ? (
                                      <span className="badge badge-green">설치됨</span>
                                    ) : (
                                      <span className="badge badge-gray">미설치</span>
                                    )}
                                    {tool.active && <span className="badge badge-green">활성</span>}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )
                        })()}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
