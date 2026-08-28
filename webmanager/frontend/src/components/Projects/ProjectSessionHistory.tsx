import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { ClaudeStatus } from '../../api/types'
import { SessionLog } from '../ClaudeCode/SessionLog/SessionLog'
import { CollapseChevron } from '../common/CollapseChevron'
import { Skeleton } from '../common/Skeleton'
import './Projects.css'

// Self-contained "Claude Code 세션 기록" section for the Projects tab's
// per-project detail sheet - takes only a filesystem `path`, same convention
// as GitStatusPanel (components/common/Git/GitStatusPanel.tsx), so it can be
// dropped into that sheet without any Projects-specific plumbing. Not wired
// into ProjectTable.tsx here - see the caller for the exact one-line
// addition, left out deliberately since that file has parallel edits
// in flight.
//
// Reuses the exact same list+viewer+password-gate machinery the Claude tab's
// own "대화 로그" sub-tab uses (ClaudeCode/SessionLog/) rather than building
// new transcript parsing - only difference is the `projectFilter` prop,
// which threads through to GET /api/claude/sessions?project=<path>
// (internal/claudecode.FilterSessionsByProject on the backend) so this
// section only shows sessions that actually touched this project, not every
// session on the instance.
//
// GET /api/claude/status is a plain ungated read (see main.go), so the
// "claude 바이너리를 찾을 수 없습니다" check below runs before - and
// independent of - SessionLog's own password gate.
export default function ProjectSessionHistory({
  path,
  onOpenTerminal,
}: {
  path: string
  onOpenTerminal?: (cwd: string, label?: string, command?: string) => void
}) {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    let cancelled = false
    api
      .get<ClaudeStatus>('/claude/status')
      .then((res) => {
        if (!cancelled) setInstalled(res.installed)
      })
      .catch(() => {
        if (!cancelled) setInstalled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="projects-detail-section">
      <button
        type="button"
        className="projects-detail-header-toggle"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <CollapseChevron open={open} />
        <span className="projects-detail-header">Claude Code 세션 기록</span>
      </button>
      {open &&
        (installed === null ? (
          <Skeleton />
        ) : !installed ? (
          <p className="empty-state">claude 바이너리를 찾을 수 없습니다.</p>
        ) : (
          <SessionLog
            projectFilter={path}
            emptyMessage="이 프로젝트에서 진행된 Claude Code 세션이 없습니다."
            onOpenTerminal={onOpenTerminal}
          />
        ))}
    </section>
  )
}
