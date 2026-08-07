import { useEffect, useState } from 'react'
import { GitBranch as GitBranchIcon } from 'lucide-react'
import { api, errorMessage } from '../../../api/client'
import type { GitBranch } from '../../../api/types'
import { ErrorBanner, Sheet, Skeleton } from '@code-docker/router-frontend'
import './Git.css'

export function GitBranchesSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<GitBranch[]>(`/projects/git/branches?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (!cancelled) setBranches(res)
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

  return (
    <Sheet open onClose={onClose} title="브랜치">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : branches.length === 0 ? (
        <p className="empty-state">브랜치가 없습니다.</p>
      ) : (
        <ul className="git-branch-list">
          {branches.map((b) => (
            <li key={b.name} className={b.current ? 'git-branch-row git-branch-row-current' : 'git-branch-row'}>
              <GitBranchIcon size={14} />
              <span className="mono-cell git-branch-name">{b.name}</span>
              {b.current && <span className="badge badge-green">현재</span>}
              <span className={b.remote ? 'badge badge-gray' : 'badge badge-yellow'}>
                {b.remote ? '원격' : '로컬'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
