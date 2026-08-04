import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { api, errorMessage } from '../../../api/client'
import type { GitCommit, GitDiffResponse, GitLogResponse } from '../../../api/types'
import { ErrorBanner } from '../ErrorBanner'
import { Sheet } from '../Sheet'
import { Skeleton } from '../Skeleton'
import { DiffView } from './DiffView'
import './Git.css'

const PAGE_SIZE = 50

// Commit list with cursor-paginated "더 보기" (same idiom as Logs.tsx /
// ClaudeCode's SessionViewer). Clicking a commit swaps the same Sheet body
// over to that commit's diff (reusing DiffView) instead of opening a nested
// Sheet - "뒤로" returns to the list without re-fetching it.
export function GitLogSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selected, setSelected] = useState<GitCommit | null>(null)
  const [diffText, setDiffText] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .get<GitLogResponse>(`/projects/git/log?path=${encodeURIComponent(path)}&limit=${PAGE_SIZE}`)
      .then((res) => {
        if (cancelled) return
        setCommits(res.commits)
        setHasMore(res.hasMore)
        setCursor(res.nextCursor)
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

  async function loadMore() {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const res = await api.get<GitLogResponse>(
        `/projects/git/log?path=${encodeURIComponent(path)}&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
      )
      setCommits((prev) => [...prev, ...res.commits])
      setHasMore(res.hasMore)
      setCursor(res.nextCursor)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoadingMore(false)
    }
  }

  function openCommit(commit: GitCommit) {
    setSelected(commit)
    setDiffText(null)
    setDiffLoading(true)
    api
      .get<GitDiffResponse>(
        `/projects/git/diff/commit?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(commit.hash)}`,
      )
      .then((res) => setDiffText(res.text))
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setDiffLoading(false))
  }

  return (
    <Sheet open onClose={onClose} title={selected ? `커밋 ${selected.shortHash}` : '커밋 로그'}>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {selected ? (
        <div className="git-commit-detail">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setSelected(null)}>
            <ArrowLeft size={14} /> 목록으로
          </button>
          <div className="git-commit-meta">
            <div className="git-commit-subject">{selected.subject}</div>
            <div className="git-commit-sub">
              {selected.authorName} &lt;{selected.authorEmail}&gt; · {new Date(selected.date).toLocaleString()}
            </div>
            <div className="mono-cell git-commit-hash">{selected.hash}</div>
          </div>
          {diffLoading ? <Skeleton /> : <DiffView text={diffText ?? ''} />}
        </div>
      ) : loading ? (
        <Skeleton />
      ) : commits.length === 0 ? (
        <p className="empty-state">커밋이 없습니다.</p>
      ) : (
        <>
          <ul className="git-commit-list">
            {commits.map((c) => (
              <li key={c.hash} className="git-commit-row" onClick={() => openCommit(c)}>
                <div className="git-commit-row-top">
                  <span className="mono-cell git-commit-shorthash">{c.shortHash}</span>
                  <span className="git-commit-row-subject">{c.subject}</span>
                </div>
                <div className="git-commit-row-meta">
                  {c.authorName} · {new Date(c.date).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
          {hasMore && (
            <button
              type="button"
              className="btn btn-secondary btn-small"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? '불러오는 중...' : '더 보기'}
            </button>
          )}
        </>
      )}
    </Sheet>
  )
}
