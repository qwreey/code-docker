import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import { ErrorBanner } from '../common/ErrorBanner'
import { Sheet } from '../common/Sheet'
import '../Supervisor/Supervisor.css'

export function DindInspectPanel({ containerId, containerName, onClose }: { containerId: string; containerName: string; onClose: () => void }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.get<Record<string, unknown>>(`/dind/containers/${encodeURIComponent(containerId)}/inspect`)
      setData(result)
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
      title={`${containerName} inspect`}
      headerActions={
        <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
          {loading ? '불러오는 중...' : '새로고침'}
        </button>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <pre className="log-panel-body">{data ? JSON.stringify(data, null, 2) : loading ? '' : '(데이터 없음)'}</pre>
    </Sheet>
  )
}
