import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranchPlus, RefreshCw } from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import type { ProjectInfo, ProjectsResponse } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { CloneProjectDialog } from './CloneProjectDialog'
import { ProjectTable } from './ProjectTable'
import '../common/common.css'
import './Projects.css'
import { withViewTransition } from '../../utils/viewTransition'

const SCAN_POLL_INTERVAL_MS = 2000

export function Projects({
  onOpenTerminal,
  onOpenFileManager,
  onOpenTerminalSession,
  initialProjectPath,
  onInitialProjectPathConsumed,
}: {
  onOpenTerminal?: (cwd: string, label?: string, command?: string) => void
  onOpenFileManager?: (path: string) => void
  onOpenTerminalSession?: (name: string) => void
  initialProjectPath?: string | null
  onInitialProjectPathConsumed?: () => void
} = {}) {
  const [data, setData] = useState<ProjectsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cloneOpen, setCloneOpen] = useState(false)

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const res = await api.get<ProjectsResponse>('/projects')
      setData(res)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
      loadingRef.current = false
    }
  }, [])

  const rescanAll = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.post<ProjectsResponse>('/projects/scan')
      setData(res)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!data?.scanning) return
    const timer = setInterval(load, SCAN_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [data?.scanning, load])

  function handleProjectUpdated(updated: ProjectInfo) {
    setData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        projects: prev.projects.map((p) => (p.path === updated.path ? updated : p)),
      }
    })
  }

  function handleProjectDeleted(path: string) {
    setData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        projects: prev.projects.filter((p) => p.path !== path),
      }
    })
  }

  return (
    <section>
      <div className="section-header">
        <h1>Projects</h1>
        <div className="projects-header-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setCloneOpen(true)}>
            <GitBranchPlus size={14} /> git clone
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={rescanAll} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'icon-spin' : undefined} /> 전체 다시 스캔
          </button>
        </div>
      </div>
      <p className="section-description">
        {data?.roots.length ? data.roots.join(', ') : '설정된 경로'} 아래 프로젝트별 용량과 재생성 가능한
        빌드/의존성 폴더를 보여줍니다. 기본 정렬은 최근 수정순이라 최근 작업한 프로젝트를 바로 확인하고
        code-server로 열 수 있습니다.
      </p>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {data?.scannedAt && (
        <p className="projects-last-scan">마지막 전체 스캔: {new Date(data.scannedAt).toLocaleString()}</p>
      )}

      {data?.scanning && <p className="projects-scanning-note">스캔이 진행 중입니다 — 완료되면 자동으로 갱신됩니다.</p>}

      {loading && !data ? (
        <Skeleton />
      ) : data && data.projects.length === 0 && !data.scanning ? (
        <p className="empty-state">스캔된 프로젝트가 없습니다.</p>
      ) : (
        data && (
          <ProjectTable
            projects={data.projects}
            codeServerUrl={data.codeServerUrl}
            onProjectUpdated={handleProjectUpdated}
            onProjectDeleted={handleProjectDeleted}
            onError={setError}
            onOpenTerminal={onOpenTerminal}
            onOpenFileManager={onOpenFileManager}
            onOpenTerminalSession={onOpenTerminalSession}
            initialProjectPath={initialProjectPath}
            onInitialProjectPathConsumed={onInitialProjectPathConsumed}
          />
        )
      )}

      <CloneProjectDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        roots={data?.roots ?? []}
        onCloned={load}
      />
    </section>
  )
}
