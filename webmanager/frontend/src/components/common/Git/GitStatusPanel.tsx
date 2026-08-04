import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  FileDiff,
  FileCheck,
  FileEdit,
  FileQuestion,
  GitBranch,
  GitCompare,
  GitFork,
  History,
  RefreshCw,
  Server,
  Tags,
  type LucideIcon,
} from 'lucide-react'
import { api, errorMessage } from '../../../api/client'
import type { GitStatus } from '../../../api/types'
import { withViewTransition } from '../../../utils/viewTransition'
import { ErrorBanner } from '../ErrorBanner'
import { Skeleton } from '../Skeleton'
import { GitBranchesSheet } from './GitBranchesSheet'
import { GitChangesSheet } from './GitChangesSheet'
import { GitLogSheet } from './GitLogSheet'
import { GitRemotesSheet } from './GitRemotesSheet'
import { GitTagsSheet } from './GitTagsSheet'
import './Git.css'

type StatKey = 'staged' | 'changed' | 'untracked' | 'ahead' | 'behind' | 'diverged' | 'stashed' | 'conflicts'

// Mirrors the fish prompt's own "skip zero values" behavior (this app's git
// summary semantics were explicitly ported from
// ~/.config/fish/functions/quiteline-fish/_qtm_git_info.fish) - only
// non-zero counts render, branch name always does.
const STAT_ITEMS: { key: StatKey; label: string; icon: LucideIcon }[] = [
  { key: 'staged', label: '스테이지됨', icon: FileCheck },
  { key: 'changed', label: '변경됨', icon: FileEdit },
  { key: 'untracked', label: '추적 안 됨', icon: FileQuestion },
  { key: 'ahead', label: '앞섬', icon: ArrowUp },
  { key: 'behind', label: '뒤처짐', icon: ArrowDown },
  { key: 'diverged', label: '분기됨', icon: GitCompare },
  { key: 'stashed', label: '스태시', icon: Archive },
  { key: 'conflicts', label: '충돌', icon: AlertTriangle },
]

type SheetKind = 'log' | 'changes' | 'remotes' | 'branches' | 'tags' | null

// Reusable, self-contained git status/inspect widget - takes only a
// filesystem `path`, no Projects-specific state or props, so it can be
// dropped into any future panel (e.g. a file-manager rework) that already
// knows a project root. Read-only: no stage/commit/push/pull/merge/stash
// tooling, matching internal/projects' git endpoints (GET-only, never
// mutates the repo).
//
// Owns its own section wrapper (Git.css's .git-panel-section, a local
// equivalent of Projects.css's .projects-detail-section so this component
// doesn't need that stylesheet loaded) rather than the caller wrapping it,
// so it can render nothing at all - no empty bordered strip - once a
// confirmed non-repo path is known, instead of just an empty inner area.
export function GitStatusPanel({ path }: { path: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openSheet, setOpenSheet] = useState<SheetKind>(null)

  async function load(isRefresh: boolean) {
    if (isRefresh) setRefreshing(true)
    try {
      const res = await api.get<GitStatus>(`/projects/git/status?path=${encodeURIComponent(path)}`)
      setStatus(res)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      if (isRefresh) setRefreshing(false)
      withViewTransition(() => setLoading(false))
    }
  }

  useEffect(() => {
    setLoading(true)
    setStatus(null)
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  if (loading) {
    return (
      <section className="git-panel-section">
        <div className="git-panel-header">Git</div>
        <Skeleton />
      </section>
    )
  }

  // Never surface a "Git" section at all for a non-repo path - only the
  // error banner (if the request itself failed) is worth showing here.
  if (!status?.isGitRepo) {
    return error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null
  }

  return (
    <section className="git-panel-section">
      <div className="git-panel-header git-status-header">
        Git
        <button
          type="button"
          className="btn btn-secondary btn-small btn-icon"
          title="새로고침"
          aria-label="새로고침"
          disabled={refreshing}
          onClick={() => load(true)}
        >
          <RefreshCw size={14} className={refreshing ? 'icon-spin' : undefined} />
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="git-status-summary">
        <span className="git-status-branch">
          <GitBranch size={14} /> {status.branch}
        </span>
        {STAT_ITEMS.filter((item) => status[item.key] > 0).map((item) => {
          const Icon = item.icon
          return (
            <span key={item.key} className="git-status-stat" title={item.label}>
              <Icon size={14} /> {status[item.key]}
            </span>
          )
        })}
      </div>

      <div className="git-status-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setOpenSheet('log')}>
          <History size={14} /> 로그
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setOpenSheet('changes')}>
          <FileDiff size={14} /> 변경사항
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setOpenSheet('remotes')}>
          <Server size={14} /> 리모트
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setOpenSheet('branches')}>
          <GitFork size={14} /> 브랜치
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setOpenSheet('tags')}>
          <Tags size={14} /> 태그
        </button>
      </div>

      {openSheet === 'log' && <GitLogSheet path={path} onClose={() => setOpenSheet(null)} />}
      {openSheet === 'changes' && <GitChangesSheet path={path} onClose={() => setOpenSheet(null)} />}
      {openSheet === 'remotes' && <GitRemotesSheet path={path} onClose={() => setOpenSheet(null)} />}
      {openSheet === 'branches' && <GitBranchesSheet path={path} onClose={() => setOpenSheet(null)} />}
      {openSheet === 'tags' && <GitTagsSheet path={path} onClose={() => setOpenSheet(null)} />}
    </section>
  )
}
