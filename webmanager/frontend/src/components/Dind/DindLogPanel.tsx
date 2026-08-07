import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { LogResponse } from '../../api/types'
import { ErrorBanner, Sheet } from '@code-docker/router-frontend'
import '../Supervisor/Supervisor.css'

const TAIL = 5000

export function DindLogPanel({ containerId, containerName, onClose }: { containerId: string; containerName: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<LogResponse>(`/dind/containers/${encodeURIComponent(containerId)}/logs?tail=${TAIL}`)
      setText(data.text)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [containerId])

  useEffect(() => {
    load()
  }, [load])

  return (
    <Sheet
      open
      onClose={onClose}
      title={`${containerName} 로그`}
      headerActions={
        <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
          {loading ? '불러오는 중...' : '새로고침'}
        </button>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <pre className="log-panel-body">{text || (loading ? '' : '(로그 없음)')}</pre>
    </Sheet>
  )
}
