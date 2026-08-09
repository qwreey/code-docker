import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { CloneProjectRequest, MiseJobStatus, ProjectCloneJob } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Sheet } from '../common/Sheet'
import { JobPanel } from '../Mise/JobPanel'

const JOB_POLL_INTERVAL_MS = 1500

// Mirrors internal/projects.cloneNameRe exactly (backend/internal/projects/
// clone.go) - a single path segment, no `/`, safe to use as a new directory
// name directly under a scan root. This is only a UX nicety (a clear inline
// error before the round-trip); the backend re-validates the same charset
// regardless, since a client-side check can never be trusted as the real
// defense.
const CLONE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Best-effort pre-fill for the destination folder name from a pasted git
// URL - handles both `https://host/owner/repo.git` and scp-like
// `git@host:owner/repo.git` syntax. Purely cosmetic; the user can always
// edit the result, and an unparseable URL just leaves the field empty.
function deriveNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const lastSegment = trimmed.split(/[/:]/).pop() ?? ''
  return lastSegment.replace(/\.git$/, '')
}

export function CloneProjectDialog({
  open,
  onClose,
  roots,
  onCloned,
}: {
  open: boolean
  onClose: () => void
  roots: string[]
  onCloned: () => void
}) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [root, setRoot] = useState(roots[0] ?? '')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [job, setJob] = useState<{ jobId: string; status: MiseJobStatus | null } | null>(null)

  const notifiedRef = useRef(false)

  function reset() {
    setUrl('')
    setName('')
    setNameEdited(false)
    setRoot(roots[0] ?? '')
    setFormError(null)
    setSubmitting(false)
    setJob(null)
    notifiedRef.current = false
  }

  function handleUrlChange(v: string) {
    setUrl(v)
    if (!nameEdited) setName(deriveNameFromUrl(v))
  }

  function handleNameChange(v: string) {
    setName(v)
    setNameEdited(true)
  }

  // This component stays mounted (Sheet just hides it) while Projects.tsx's
  // own GET /projects is still in flight, so the roots[0] ?? '' useState
  // initializer above can capture an empty list before the real roots ever
  // arrive. Re-sync whenever the dialog opens (or roots itself changes
  // while open) unless the user already picked a still-valid root.
  useEffect(() => {
    if (!open) return
    setRoot((prev) => (prev && roots.includes(prev) ? prev : (roots[0] ?? '')))
  }, [open, roots])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      setFormError('git URL을 입력해 주세요.')
      return
    }
    if (!name || !CLONE_NAME_RE.test(name)) {
      setFormError('폴더 이름은 영문/숫자로 시작하고 영문, 숫자, ".", "_", "-"만 사용할 수 있습니다.')
      return
    }

    setSubmitting(true)
    setFormError(null)
    try {
      const body: CloneProjectRequest = { url: trimmedUrl, name }
      if (roots.length > 1) body.root = root
      const res = await api.post<ProjectCloneJob>('/projects/clone', body)
      setJob({ jobId: res.jobId, status: null })
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  // Poll the clone job's progress while it's running - JobPanel is a pure
  // display component (see its own doc comment: callers own polling).
  useEffect(() => {
    if (!job || (job.status && !job.status.running)) return
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const status = await api.get<MiseJobStatus>(`/projects/jobs/${encodeURIComponent(job.jobId)}`)
        if (!cancelled) setJob((prev) => (prev && prev.jobId === job.jobId ? { ...prev, status } : prev))
      } catch {
        // Transient poll failure - next tick retries, same as
        // ClaudeCode.tsx's own install-job polling.
      }
    }, JOB_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [job])

  // Once the clone finishes successfully, refresh the project list exactly
  // once (the backend's own onDone callback already triggered a rescan -
  // this just makes the frontend pick it up without waiting for the next
  // manual refresh).
  useEffect(() => {
    if (job?.status && !job.status.running && job.status.exitCode === 0 && !notifiedRef.current) {
      notifiedRef.current = true
      onCloned()
    }
  }, [job?.status, onCloned])

  function handleDialogClose() {
    reset()
    onClose()
  }

  return (
    <Sheet open={open} onClose={handleDialogClose} title="git clone으로 새 프로젝트">
      {!job ? (
        <form onSubmit={handleSubmit} className="form-grid-inline">
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="clone-project-url">git URL</label>
              <input
                id="clone-project-url"
                type="text"
                placeholder="https://github.com/owner/repo.git"
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="form-field">
              <label htmlFor="clone-project-name">대상 폴더 이름</label>
              <input
                id="clone-project-name"
                type="text"
                placeholder="repo"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                required
              />
            </div>
            {roots.length > 1 && (
              <div className="form-field">
                <label htmlFor="clone-project-root">저장 위치</label>
                <select id="clone-project-root" value={root} onChange={(e) => setRoot(e.target.value)}>
                  {roots.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}

          <button type="submit" className="btn btn-primary" disabled={submitting || !url.trim() || !name}>
            {submitting ? '시작하는 중...' : 'Clone'}
          </button>
        </form>
      ) : (
        <JobPanel kind="install" actionLabel="Clone" toolLabel={name} status={job.status} onClose={handleDialogClose} offerRestart={false} />
      )}
    </Sheet>
  )
}
