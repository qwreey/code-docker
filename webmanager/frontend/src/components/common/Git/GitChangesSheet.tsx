import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../../api/client'
import type { GitDiffResponse } from '../../../api/types'
import { ErrorBanner, Sheet, Skeleton } from '@code-docker/router-frontend'
import { DiffView } from './DiffView'
import './Git.css'

type Mode = 'unstaged' | 'staged'

// Unstaged/staged diff, toggled within one Sheet rather than two separate
// ones - each mode's text is fetched once and cached in state so switching
// back and forth doesn't re-hit the backend.
export function GitChangesSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('unstaged')
  const [unstagedText, setUnstagedText] = useState<string | null>(null)
  const [stagedText, setStagedText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const cached = mode === 'unstaged' ? unstagedText : stagedText
    if (cached !== null) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .get<GitDiffResponse>(`/projects/git/diff/${mode}?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (cancelled) return
        if (mode === 'unstaged') setUnstagedText(res.text)
        else setStagedText(res.text)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unstagedText/stagedText read only as a cache check, not to re-trigger
  }, [path, mode])

  const text = mode === 'unstaged' ? unstagedText : stagedText

  return (
    <Sheet open onClose={onClose} title="변경사항">
      <div className="git-changes-toggle">
        <button
          type="button"
          className={`btn btn-small ${mode === 'unstaged' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMode('unstaged')}
        >
          Unstaged
        </button>
        <button
          type="button"
          className={`btn btn-small ${mode === 'staged' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMode('staged')}
        >
          Staged
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? <Skeleton /> : <DiffView text={text ?? ''} />}
    </Sheet>
  )
}
