import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { LFSStatus } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

export function GitLFS() {
  const [installed, setInstalled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.get<LFSStatus>('/git/lfs/status')
      setInstalled(data.installed)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleInstall() {
    setInstalling(true)
    setError(null)
    try {
      await api.post<{ ok: true }>('/git/lfs/install')
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="card">
      <h2>Git LFS</h2>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : installed ? (
        <span className="badge badge-green">설치됨</span>
      ) : (
        <div className="git-lfs-not-installed">
          <p className="empty-state">git-lfs가 아직 설치되어 있지 않습니다.</p>
          <button type="button" className="btn btn-primary" disabled={installing} onClick={handleInstall}>
            {installing ? '설치하는 중...' : '설치'}
          </button>
        </div>
      )}
    </div>
  )
}
