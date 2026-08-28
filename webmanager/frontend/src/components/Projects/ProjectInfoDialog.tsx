import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { ProjectInfo, ProjectsResponse } from '../../api/types'
import { formatBytes } from '../../utils/format'
import { ErrorBanner } from '../common/ErrorBanner'
import { GitStatusPanel } from '../common/Git/GitStatusPanel'
import { WorktreesPanel } from '../common/Git/WorktreesPanel'
import { Sheet } from '../common/Sheet'
import { Skeleton } from '../common/Skeleton'
import ProjectMemoryPanel from './ProjectMemoryPanel'
import ProjectSessionHistory from './ProjectSessionHistory'
import ProjectTerminalSessions from './ProjectTerminalSessions'
import './Projects.css'

// A project's info as a dialog over whatever tab you're already on, instead
// of a jump to the Projects tab. Built for the Terminal tab's "프로젝트
// 정보" button (App.tsx's openProjectInfo): looking up which project the
// current shell is in shouldn't cost you the terminal you were watching.
//
// Deliberately read-only. It composes the same path-only panels the Projects
// detail sheet renders, so those can't visually drift apart, but leaves the
// managing actions (rescan, reclaimable-folder deletion, project deletion)
// to the Projects tab that owns them — a dialog you open mid-terminal is a
// bad place to be offered a delete button. "Projects 탭에서 열기" is right
// there when that's what you actually wanted.
export function ProjectInfoDialog({
  path,
  onClose,
  onOpenInProjectsTab,
  onOpenTerminal,
  onOpenTerminalSession,
}: {
  path: string | null
  onClose: () => void
  onOpenInProjectsTab?: (path: string) => void
  onOpenTerminal?: (cwd: string, label?: string, command?: string) => void
  onOpenTerminalSession?: (name: string) => void
}) {
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // There's no by-path endpoint; GET /projects is the scan cache, already
  // loaded whenever the Projects tab has been opened, and cheap enough for a
  // dialog that only opens on an explicit click.
  useEffect(() => {
    if (!path) {
      setProject(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .get<ProjectsResponse>('/projects')
      .then((res) => {
        if (cancelled) return
        setProject(res.projects.find((p) => p.path === path) ?? null)
        setError(null)
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  if (!path) return null

  return (
    <Sheet
      open
      onClose={onClose}
      title={project?.name ?? path}
      headerActions={
        onOpenInProjectsTab && (
          <button type="button" className="btn btn-secondary btn-small" onClick={() => onOpenInProjectsTab(path)}>
            Projects 탭에서 열기
          </button>
        )
      }
    >
      <div className="projects-detail-sections">
        <section className="projects-detail-section">
          <div className="projects-detail-header">개요</div>
          <div className="projects-path mono-cell">{path}</div>
          {loading ? (
            <Skeleton />
          ) : error ? (
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          ) : !project ? (
            // A path under a project root that has never been scanned (or a
            // directory outside every root) — the panels below still work,
            // since they only need the path itself.
            <p className="empty-state">스캔된 프로젝트 정보가 없습니다.</p>
          ) : (
            <>
              <div className="projects-detail-meta">
                총 용량 {formatBytes(project.totalSizeBytes)} · 재생성 가능 폴더 합계{' '}
                {formatBytes(project.reclaimableSizeBytes)} · 마지막 스캔{' '}
                {new Date(project.scannedAt).toLocaleString()}
                {project.stale && <span className="badge badge-yellow projects-detail-stale">오래됨</span>}
              </div>
              <div className="projects-detail-tech">
                {project.techStack.length === 0 ? (
                  <span className="projects-no-badge">-</span>
                ) : (
                  project.techStack.map((tech) => (
                    <span key={tech} className="badge badge-gray projects-tech-badge">
                      {tech}
                    </span>
                  ))
                )}
              </div>
            </>
          )}
        </section>

        <ProjectTerminalSessions path={path} onOpenSession={onOpenTerminalSession} />
        <GitStatusPanel path={path} />
        <WorktreesPanel path={path} />
        <ProjectSessionHistory path={path} onOpenTerminal={onOpenTerminal} />
        <ProjectMemoryPanel path={path} />
      </div>
    </Sheet>
  )
}
