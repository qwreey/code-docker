import { useEffect, useRef, useState } from 'react'
import { ExternalLink, FolderOpen, RefreshCw, Terminal as TerminalIcon, Trash2 } from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import type { MiseToolEntry, MiseToolsResponse, ProjectInfo, ReclaimableEntry } from '../../api/types'
import { formatBytes } from '../../utils/format'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { GitStatusPanel } from '../common/Git/GitStatusPanel'
import { WorktreesPanel } from '../common/Git/WorktreesPanel'
import { Sheet } from '../common/Sheet'
import { useAuthStatus } from '../common/useAuthStatus'
import { ensureUnlocked } from '../common/useUnlockGate'
import { DeleteReclaimableDialog } from './DeleteReclaimableDialog'
import ProjectMemoryPanel from './ProjectMemoryPanel'
import ProjectSessionHistory from './ProjectSessionHistory'
import ProjectTerminalSessions from './ProjectTerminalSessions'
import '../common/common.css'
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
  onProjectDeleted,
  onError,
  onOpenTerminal,
  onOpenFileManager,
  onOpenTerminalSession,
  initialProjectPath,
  onInitialProjectPathConsumed,
  onSelectedProjectChange,
}: {
  projects: ProjectInfo[]
  codeServerUrl: string
  onProjectUpdated: (project: ProjectInfo) => void
  onProjectDeleted: (path: string) => void
  onError: (message: string) => void
  onOpenTerminal?: (cwd: string, label?: string, command?: string) => void
  onOpenFileManager?: (path: string) => void
  onOpenTerminalSession?: (name: string) => void
  initialProjectPath?: string | null
  onInitialProjectPathConsumed?: () => void
  onSelectedProjectChange?: (path: string | null) => void
}) {
  const [sortKey, setSortKey] = useState<SortKey>('lastModified')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const { status: authStatus } = useAuthStatus()
  const [detailsPath, setDetailsPath] = useState<string | null>(null)
  // Kept in a ref so this effect doesn't re-fire when the parent hands down a
  // freshly-created callback on every render.
  const onSelectedProjectChangeRef = useRef(onSelectedProjectChange)
  onSelectedProjectChangeRef.current = onSelectedProjectChange
  useEffect(() => {
    onSelectedProjectChangeRef.current?.(detailsPath)
  }, [detailsPath])
  const [rescanning, setRescanning] = useState<Set<string>>(new Set())
  const [miseTools, setMiseTools] = useState<Map<string, MiseToolEntry[]>>(new Map())
  const [miseLoading, setMiseLoading] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<{ project: ProjectInfo; entry: ReclaimableEntry } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [pendingDeleteProject, setPendingDeleteProject] = useState<ProjectInfo | null>(null)
  const [deletingProject, setDeletingProject] = useState(false)

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

  // Gated once here, at the open action itself, so the panels the detail
  // sheet renders (ProjectTerminalSessions, SessionLog inside
  // ProjectSessionHistory) see an already-unlocked cookie instead of each
  // popping its own prompt - see useUnlockGate.ts.
  async function openDetails(project: ProjectInfo) {
    if (!(await ensureUnlocked(authStatus))) return
    setDetailsPath(project.path)
    if (isStale(project.scannedAt)) {
      rescanProject(project.path)
    }
    loadMiseTools(project.path)
  }

  // Consumes an "open this project's detail sheet" request handed down from
  // elsewhere (App.tsx's openProject — reached from ProjectInfoDialog's
  // "Projects 탭에서 열기") - if the path doesn't match a
  // known project (e.g. an unscanned nested folder), this is a silent no-op
  // rather than an error, same tolerance as the reverse jump's path-prefix
  // matching in ProjectTerminalSessions.
  useEffect(() => {
    if (!initialProjectPath) return
    const project = projects.find((p) => p.path === initialProjectPath)
    if (project) openDetails(project)
    onInitialProjectPathConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProjectPath])

  // Same-origin fallback: nginx now serves code-server (/) and webmanager
  // (/manager) from the same origin/port, so the page webmanager is loaded
  // from is also code-server's origin in the common case. codeServerUrl
  // (WEBMANAGER_CODE_SERVER_URL) only needs to be set explicitly when
  // webmanager is reached through a different domain/port than code-server.
  const effectiveCodeServerUrl = codeServerUrl || window.location.origin

  function codeServerHref(path: string): string {
    return `${effectiveCodeServerUrl}/?folder=${encodeURIComponent(path)}`
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    const { project, entry } = pendingDelete
    setDeleting(true)
    try {
      const updated = await api.post<ProjectInfo>(
        `/projects/delete-reclaimable?path=${encodeURIComponent(project.path)}&target=${encodeURIComponent(entry.path)}`,
      )
      onProjectUpdated(updated)
      setPendingDelete(null)
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setDeleting(false)
    }
  }

  async function confirmDeleteProject() {
    if (!pendingDeleteProject) return
    const project = pendingDeleteProject
    setDeletingProject(true)
    try {
      await api.post(`/projects/delete?path=${encodeURIComponent(project.path)}`)
      onProjectDeleted(project.path)
      setPendingDeleteProject(null)
      if (detailsPath === project.path) setDetailsPath(null)
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setDeletingProject(false)
    }
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

  const detailsProject = detailsPath ? (projects.find((p) => p.path === detailsPath) ?? null) : null

  return (
    <div className="table-wrapper">
      <table className="process-info-table projects-table">
        <thead>
          <tr>
            <th aria-label="상세보기" />
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
            <th aria-label="동작" className="table-actions-col" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((project) => {
            const isRescanning = rescanning.has(project.path)
            return (
              <tr key={project.path} className="projects-row" onClick={() => openDetails(project)}>
                <td className="projects-expand-cell" aria-hidden="true">
                  ▶
                </td>
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
                <td className="table-actions-col">
                  <div className="projects-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-small btn-icon"
                      title="새로고침"
                      aria-label="새로고침"
                      disabled={isRescanning}
                      onClick={(e) => {
                        e.stopPropagation()
                        rescanProject(project.path)
                      }}
                    >
                      <RefreshCw size={14} className={isRescanning ? 'icon-spin' : undefined} />
                    </button>
                    <a
                      href={codeServerHref(project.path)}
                      target="_top"
                      className="btn btn-secondary btn-small btn-icon"
                      title="code-server에서 열기"
                      aria-label="code-server에서 열기"
                      onClick={(e) => e.stopPropagation()}
                      rel="noopener"
                    >
                      <ExternalLink size={14} />
                    </a>
                    {onOpenTerminal && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small btn-icon"
                        title="터미널에서 열기"
                        aria-label="터미널에서 열기"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenTerminal(project.path)
                        }}
                      >
                        <TerminalIcon size={14} />
                      </button>
                    )}
                    {onOpenFileManager && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small btn-icon"
                        title="파일 브라우저에서 열기"
                        aria-label="파일 브라우저에서 열기"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenFileManager(project.path)
                        }}
                      >
                        <FolderOpen size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-danger btn-small btn-icon"
                      title="프로젝트 삭제"
                      aria-label="프로젝트 삭제"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingDeleteProject(project)
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {detailsProject && (
        <Sheet
          open
          onClose={() => setDetailsPath(null)}
          title={detailsProject.name}
          headerActions={
            <>
              {onOpenTerminal && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small btn-icon"
                  title="터미널에서 열기"
                  aria-label="터미널에서 열기"
                  onClick={() => onOpenTerminal(detailsProject.path)}
                >
                  <TerminalIcon size={14} />
                </button>
              )}
              {onOpenFileManager && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small btn-icon"
                  title="파일 브라우저에서 열기"
                  aria-label="파일 브라우저에서 열기"
                  onClick={() => onOpenFileManager(detailsProject.path)}
                >
                  <FolderOpen size={14} />
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger btn-small btn-icon"
                title="프로젝트 삭제"
                aria-label="프로젝트 삭제"
                onClick={() => setPendingDeleteProject(detailsProject)}
              >
                <Trash2 size={14} />
              </button>
            </>
          }
        >
          <div className="projects-detail-sections">
            <section className="projects-detail-section">
              <div className="projects-detail-header">개요</div>
              <div className="projects-path mono-cell">{detailsProject.path}</div>
              <div className="projects-detail-meta">
                총 용량 {formatBytes(detailsProject.totalSizeBytes)} · 재생성 가능 폴더 합계{' '}
                {formatBytes(detailsProject.reclaimableSizeBytes)} · 마지막 스캔{' '}
                {new Date(detailsProject.scannedAt).toLocaleString()}
                {detailsProject.stale && <span className="badge badge-yellow projects-detail-stale">오래됨</span>}
              </div>
              <div className="projects-detail-tech">
                {detailsProject.techStack.length === 0 ? (
                  <span className="projects-no-badge">-</span>
                ) : (
                  detailsProject.techStack.map((tech) => (
                    <span key={tech} className="badge badge-gray projects-tech-badge">
                      {tech}
                    </span>
                  ))
                )}
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={rescanning.has(detailsProject.path)}
                onClick={() => rescanProject(detailsProject.path)}
              >
                <RefreshCw size={14} className={rescanning.has(detailsProject.path) ? 'icon-spin' : undefined} />{' '}
                다시 스캔
              </button>
            </section>

            {/* Open terminal sessions sit directly under 개요, ahead of the
                heavier read-only panels below: there are only ever a handful
                of them, and jumping back into one is a much more likely
                reason to open this sheet than reading a git status. */}
            <ProjectTerminalSessions path={detailsProject.path} onOpenSession={onOpenTerminalSession} />

            <section className="projects-detail-section">
              <div className="projects-detail-header">재생성 가능한 폴더</div>
              {detailsProject.reclaimable.length === 0 ? (
                <p className="empty-state">재생성 가능한 폴더가 없습니다.</p>
              ) : (
                <table className="projects-reclaimable-table">
                  <thead>
                    <tr>
                      <th>패턴</th>
                      <th>경로</th>
                      <th>용량</th>
                      <th aria-label="동작" className="table-actions-col" />
                    </tr>
                  </thead>
                  <tbody>
                    {detailsProject.reclaimable.map((entry) => (
                      <tr key={entry.path}>
                        <td>
                          <span className="badge badge-gray">{entry.pattern}</span>
                        </td>
                        <td className="mono-cell">{entry.path}</td>
                        <td>{formatBytes(entry.sizeBytes)}</td>
                        <td className="table-actions-col">
                          <button
                            type="button"
                            className="btn btn-danger btn-small"
                            onClick={() => setPendingDelete({ project: detailsProject, entry })}
                          >
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="projects-detail-section">
              <div className="projects-detail-header">이 프로젝트가 쓰는 도구</div>
              {miseLoading.has(detailsProject.path) ? (
                <p className="empty-state projects-mise-loading">mise 도구 확인 중...</p>
              ) : (miseTools.get(detailsProject.path) ?? []).length === 0 ? (
                <p className="empty-state">감지된 도구가 없습니다.</p>
              ) : (
                <ul className="projects-mise-list">
                  {(miseTools.get(detailsProject.path) ?? []).map((tool) => (
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
              )}
            </section>

            <GitStatusPanel path={detailsProject.path} />
            <WorktreesPanel path={detailsProject.path} />
            <ProjectSessionHistory path={detailsProject.path} onOpenTerminal={onOpenTerminal} />
            <ProjectMemoryPanel path={detailsProject.path} />
          </div>
        </Sheet>
      )}

      {pendingDelete && (
        <DeleteReclaimableDialog
          entry={pendingDelete.entry}
          busy={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}

      <ConfirmDialog
        open={pendingDeleteProject !== null}
        onClose={() => setPendingDeleteProject(null)}
        onConfirm={confirmDeleteProject}
        title="프로젝트 삭제"
        confirmLabel="삭제"
        busyLabel="삭제 중..."
        busy={deletingProject}
        requireTypedConfirmation={pendingDeleteProject?.name}
        requireCheckbox="이 작업은 되돌릴 수 없음을 이해했습니다"
      >
        {pendingDeleteProject && (
          <>
            <p className="section-description">
              다음 프로젝트 폴더 전체를 디스크에서 완전히 삭제합니다. 재생성 가능한 폴더뿐 아니라 소스 코드를
              포함한 모든 내용이 사라지며 되돌릴 수 없습니다.
            </p>
            <div className="projects-delete-target">
              <div className="mono-cell projects-delete-path">{pendingDeleteProject.path}</div>
              <div className="projects-delete-size">{formatBytes(pendingDeleteProject.totalSizeBytes)}</div>
            </div>
          </>
        )}
      </ConfirmDialog>
    </div>
  )
}
