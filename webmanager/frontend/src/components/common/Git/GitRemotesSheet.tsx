import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../../api/client'
import type { GitRemote } from '../../../api/types'
import { ErrorBanner, Sheet, Skeleton } from '@code-docker/router-frontend'
import './Git.css'

export function GitRemotesSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<GitRemote[]>(`/projects/git/remotes?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (!cancelled) setRemotes(res)
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
    <Sheet open onClose={onClose} title="리모트">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : remotes.length === 0 ? (
        <p className="empty-state">등록된 리모트가 없습니다.</p>
      ) : (
        <ul className="git-remote-list">
          {remotes.map((r) => (
            <li key={r.name} className="git-remote-row">
              <div className="git-remote-name">{r.name}</div>
              <div className="mono-cell git-remote-url">fetch {r.fetchUrl}</div>
              <div className="mono-cell git-remote-url">push {r.pushUrl}</div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
