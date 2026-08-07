import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../../api/client'
import type { GitTag } from '../../../api/types'
import { ErrorBanner, Sheet, Skeleton } from '@code-docker/router-frontend'
import './Git.css'

export function GitTagsSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const [tags, setTags] = useState<GitTag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<GitTag[]>(`/projects/git/tags?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (!cancelled) setTags(res)
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
    <Sheet open onClose={onClose} title="태그">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : tags.length === 0 ? (
        <p className="empty-state">태그가 없습니다.</p>
      ) : (
        <ul className="git-tag-list">
          {tags.map((t) => (
            <li key={t.name} className="git-tag-row">
              <span className="mono-cell git-tag-name">{t.name}</span>
              {t.date && <span className="git-tag-date">{new Date(t.date).toLocaleString()}</span>}
              {t.hash && <span className="mono-cell git-tag-hash">{t.hash.slice(0, 10)}</span>}
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
