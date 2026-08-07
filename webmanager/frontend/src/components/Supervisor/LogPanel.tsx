import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { LogResponse, LogStream } from '../../api/types'
import { ErrorBanner, Sheet } from '@code-docker/router-frontend'
import './Supervisor.css'

const TAIL = 10000

export function LogPanel({ processName, onClose }: { processName: string; onClose: () => void }) {
  const [stream, setStream] = useState<LogStream>('stdout')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<LogResponse>(
        `/supervisor/processes/${encodeURIComponent(processName)}/log?stream=${stream}&tail=${TAIL}`,
      )
      setText(data.text)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [processName, stream])

  useEffect(() => {
    load()
  }, [load])

  return (
    <Sheet
      open
      onClose={onClose}
      title={`${processName} 로그`}
      headerActions={
        <>
          <div className="log-stream-toggle">
            <button
              type="button"
              className={stream === 'stdout' ? 'toggle-active' : ''}
              onClick={() => setStream('stdout')}
            >
              stdout
            </button>
            <button
              type="button"
              className={stream === 'stderr' ? 'toggle-active' : ''}
              onClick={() => setStream('stderr')}
            >
              stderr
            </button>
          </div>
          <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
            {loading ? '불러오는 중...' : '새로고침'}
          </button>
        </>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <pre className="log-panel-body">{text || (loading ? '' : '(로그 없음)')}</pre>
    </Sheet>
  )
}
