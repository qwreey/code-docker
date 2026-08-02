import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { SupervisorProcess } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { ProcessTable } from './ProcessTable'
import { LogPanel } from './LogPanel'
import '../common/common.css'
import './Supervisor.css'

const POLL_INTERVAL_MS = 4000

export function Supervisor() {
  const [processes, setProcesses] = useState<SupervisorProcess[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [logTarget, setLogTarget] = useState<string | null>(null)

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const data = await api.get<SupervisorProcess[]>('/supervisor/processes')
      setProcesses(data)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  async function handleAction(name: string, action: 'start' | 'stop' | 'restart') {
    setBusy((prev) => ({ ...prev, [name]: true }))
    try {
      await api.post(`/supervisor/processes/${encodeURIComponent(name)}/${action}`)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy((prev) => ({ ...prev, [name]: false }))
    }
  }

  return (
    <section>
      <div className="section-header">
        <h1>Supervisor</h1>
        <button type="button" className="btn btn-secondary btn-small" onClick={load}>
          새로고침
        </button>
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <p className="empty-state">불러오는 중...</p>
      ) : (
        <ProcessTable
          processes={processes}
          busy={busy}
          onAction={handleAction}
          onShowLogs={(name) => setLogTarget(name)}
        />
      )}
      {logTarget && <LogPanel processName={logTarget} onClose={() => setLogTarget(null)} />}
    </section>
  )
}
