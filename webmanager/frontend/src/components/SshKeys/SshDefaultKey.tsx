import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { CopyButton } from '../common/CopyButton'
import { withViewTransition } from '../../utils/viewTransition'

interface DefaultKeyStatus {
  exists: boolean
  publicKey: string
}

export function SshDefaultKey() {
  const [status, setStatus] = useState<DefaultKeyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.get<DefaultKeyStatus>('/git/ssh-default-key')
      setStatus(data)
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

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      await api.post<{ publicKey: string }>('/git/ssh-default-key', {})
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="card">
      <h2>기본 SSH 키</h2>
      <p className="section-description">
        별도 <code>Host</code> 설정이 없는 서버에 접속할 때(예: <code>git clone git@github.com:...</code>) SSH가 자동으로
        사용하는 컨테이너의 기본 개인키입니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : status?.exists ? (
        <div className="copyable-block">
          <code>{status.publicKey}</code>
          <CopyButton text={status.publicKey} />
        </div>
      ) : (
        <div className="ssh-default-key-empty">
          <p className="empty-state">아직 기본 키가 없습니다.</p>
          <button type="button" className="btn btn-primary" disabled={generating} onClick={handleGenerate}>
            {generating ? '생성하는 중...' : '키 생성'}
          </button>
        </div>
      )}
    </div>
  )
}
