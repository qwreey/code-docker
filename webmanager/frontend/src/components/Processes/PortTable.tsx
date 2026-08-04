import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { PortInfo } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { KillButtons } from './KillButtons'
import './Processes.css'
import { withViewTransition } from '../../utils/viewTransition'

const POLL_INTERVAL_MS = 4000

export function PortTable() {
  const [ports, setPorts] = useState<PortInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const data = await api.get<PortInfo[]>('/ports')
      setPorts(data)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  return (
    <div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : ports.length === 0 ? (
        <p className="empty-state">리스닝 중인 포트가 없습니다.</p>
      ) : (
        <div className="table-wrapper">
          <table className="process-info-table">
            <thead>
              <tr>
                <th>프로토콜</th>
                <th>주소</th>
                <th>PID</th>
                <th>프로세스명</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {ports.map((port) => {
                const key = `${port.protocol}-${port.localAddress}-${port.localPort}`
                const resolvable = port.pid > 0
                return (
                  <tr key={key}>
                    <td>
                      <span className={`badge ${port.protocol === 'tcp' ? 'badge-green' : 'badge-yellow'}`}>
                        {port.protocol.toUpperCase()}
                      </span>
                    </td>
                    <td className="mono-cell">
                      {port.localAddress}:{port.localPort}
                    </td>
                    <td>{resolvable ? port.pid : '—'}</td>
                    <td>{resolvable ? port.processName || '-' : '알 수 없음'}</td>
                    <td>
                      <KillButtons
                        pid={port.pid}
                        label={port.processName || `PID ${port.pid}`}
                        disabled={!resolvable}
                        onKilled={load}
                        onError={setError}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
