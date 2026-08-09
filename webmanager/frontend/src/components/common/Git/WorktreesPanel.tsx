import { useEffect, useState } from 'react'
import { AlertTriangle, Lock, RefreshCw, Trash2 } from 'lucide-react'
import { ApiError, api, errorMessage } from '../../../api/client'
import type { GitWorktree } from '../../../api/types'
import { withViewTransition } from '../../../utils/viewTransition'
import { ConfirmDialog } from '../ConfirmDialog'
import { ErrorBanner } from '../ErrorBanner'
import { Skeleton } from '../Skeleton'
import './Git.css'

// Worktree list + remove panel for one project path. Deliberately its own
// component rather than another button+sheet on GitStatusPanel - that
// component's doc comment explicitly promises "read-only: no stage/commit/
// push/pull/merge/stash tooling", and `git worktree remove` is a real repo
// mutation, unlike every action GitStatusPanel currently exposes. Meant to
// sit as a sibling section right next to <GitStatusPanel path={...} /> in a
// project's detail sheet (see ProjectTable.tsx), not nested inside it -
// same "own header + refresh button, own git-panel-section wrapper" shape
// so it drops in the same way.
export function WorktreesPanel({ path }: { path: string }) {
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notRepo, setNotRepo] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<GitWorktree | null>(null)
  const [force, setForce] = useState(false)
  const [removing, setRemoving] = useState(false)

  async function load(isRefresh: boolean) {
    if (isRefresh) setRefreshing(true)
    try {
      const res = await api.get<GitWorktree[]>(`/projects/git/worktrees?path=${encodeURIComponent(path)}`)
      setWorktrees(res)
      setNotRepo(false)
      setError(null)
    } catch (e) {
      // Mirrors GitStatusPanel's own "never surface a Git section for a
      // non-repo path" rule - projectgit.Worktrees reports ErrNotGitRepo as
      // a 400 (see writeProjectGitErr), unlike Status which reports it as a
      // plain isGitRepo:false value instead of an error.
      if (e instanceof ApiError && e.status === 400 && e.message === 'not a git repository') {
        setNotRepo(true)
      } else {
        setError(errorMessage(e))
      }
    } finally {
      if (isRefresh) setRefreshing(false)
      withViewTransition(() => setLoading(false))
    }
  }

  useEffect(() => {
    setLoading(true)
    setWorktrees([])
    setNotRepo(false)
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  async function confirmRemove() {
    if (!pendingRemove) return
    setRemoving(true)
    try {
      await api.post(
        `/projects/git/worktrees/remove?path=${encodeURIComponent(path)}&target=${encodeURIComponent(
          pendingRemove.path,
        )}&force=${force}`,
      )
      setPendingRemove(null)
      setForce(false)
      load(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRemoving(false)
    }
  }

  if (loading) {
    return (
      <section className="git-panel-section">
        <div className="git-panel-header">워크트리</div>
        <Skeleton />
      </section>
    )
  }

  if (notRepo) {
    return error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null
  }

  return (
    <section className="git-panel-section">
      <div className="git-panel-header git-status-header">
        워크트리
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

      {worktrees.length === 0 ? (
        <p className="empty-state">워크트리가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="git-worktree-table">
            <thead>
              <tr>
                <th>경로</th>
                <th>브랜치</th>
                <th>상태</th>
                <th aria-label="동작" className="table-actions-col" />
              </tr>
            </thead>
            <tbody>
              {worktrees.map((wt) => {
                const isMain = wt.path === path
                return (
                  <tr key={wt.path}>
                    <td className="mono-cell">{wt.path}</td>
                    <td>
                      {wt.bare ? (
                        <span className="badge badge-gray">bare</span>
                      ) : wt.detached ? (
                        <span className="badge badge-gray">
                          detached{wt.head ? ` @ ${wt.head.slice(0, 7)}` : ''}
                        </span>
                      ) : (
                        <span className="mono-cell">{wt.branch}</span>
                      )}
                    </td>
                    <td>
                      <div className="git-worktree-flags">
                        {isMain && <span className="badge badge-green">메인</span>}
                        {wt.locked && (
                          <span className="badge badge-yellow" title={wt.lockReason || undefined}>
                            <Lock size={12} /> 잠김
                          </span>
                        )}
                        {wt.prunable && (
                          <span className="badge badge-red" title={wt.prunableReason || undefined}>
                            <AlertTriangle size={12} /> 정리 가능
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="table-actions-col">
                      {!isMain && (
                        <button
                          type="button"
                          className="btn btn-danger btn-small btn-icon"
                          title="워크트리 삭제"
                          aria-label="워크트리 삭제"
                          onClick={() => {
                            setForce(false)
                            setPendingRemove(wt)
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        onConfirm={confirmRemove}
        title="워크트리 삭제"
        confirmLabel="삭제"
        busyLabel="삭제 중..."
        busy={removing}
      >
        {pendingRemove && (
          <>
            <p className="section-description">
              다음 워크트리 디렉터리를 삭제합니다. 워크트리 안에 커밋되지 않은 변경사항이 있다면 함께 사라지며 되돌릴
              수 없습니다.
            </p>
            <div className="mono-cell">{pendingRemove.path}</div>
            <label className="confirm-dialog-checkbox">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                disabled={removing}
              />
              커밋되지 않은 변경사항이 있어도 강제로 삭제 (--force)
            </label>
          </>
        )}
      </ConfirmDialog>
    </section>
  )
}
