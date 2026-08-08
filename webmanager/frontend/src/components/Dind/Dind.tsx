import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { DindContainer, DindImage } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ContainerTable } from './ContainerTable'
import { ImageTable } from './ImageTable'
import { DindLogPanel } from './DindLogPanel'
import { DindInspectPanel } from './DindInspectPanel'
import '../Processes/Processes.css'
import { withViewTransition } from '../../utils/viewTransition'

const POLL_INTERVAL_MS = 5000

type Tab = 'containers' | 'images'

// M1 (read-only: list containers/images + tail logs), M2 (start/stop/
// remove, password-gated on the backend, mandatory confirm dialogs here),
// and M3 (docker inspect detail view, also password-gated — Config.Env can
// contain secrets) are all implemented. docker run/exec/cp stay out of scope
// indefinitely — see webmanager/.claude/dind-plan.md.
export function Dind() {
  const [tab, setTab] = useState<Tab>('containers')
  const [containers, setContainers] = useState<DindContainer[]>([])
  const [images, setImages] = useState<DindImage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logTarget, setLogTarget] = useState<DindContainer | null>(null)
  const [inspectTarget, setInspectTarget] = useState<DindContainer | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const [c, i] = await Promise.all([
        api.get<DindContainer[]>('/dind/containers'),
        api.get<DindImage[]>('/dind/images'),
      ])
      setContainers(c)
      setImages(i)
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

  // Confirm dialogs happen in ContainerTable (it has the per-row state/name
  // needed to word them correctly); this just performs the already-confirmed
  // action and refetches immediately afterward so the poll interval isn't
  // the only thing keeping the table fresh (per the plan doc).
  async function handleAction(id: string, action: 'start' | 'stop' | 'remove', force = false) {
    setBusy((prev) => ({ ...prev, [id]: true }))
    try {
      const suffix = action === 'remove' && force ? '?force=true' : ''
      await api.post(`/dind/containers/${encodeURIComponent(id)}/${action}${suffix}`)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy((prev) => ({ ...prev, [id]: false }))
    }
  }

  return (
    <section>
      <div className="section-header">
        <h1>Docker (dind)</h1>
        <div className="processes-tabs processes-maintabs">
          <button
            type="button"
            className={`processes-tab${tab === 'containers' ? ' processes-tab-active' : ''}`}
            onClick={() => setTab('containers')}
          >
            컨테이너 {containers.length > 0 ? `(${containers.length})` : ''}
          </button>
          <button
            type="button"
            className={`processes-tab${tab === 'images' ? ' processes-tab-active' : ''}`}
            onClick={() => setTab('images')}
          >
            이미지 {images.length > 0 ? `(${images.length})` : ''}
          </button>
        </div>
      </div>
      <p className="section-description">
        {tab === 'containers'
          ? 'code-docker-dind 사이드카 안에서 실행 중이거나 정지된 컨테이너 목록입니다.'
          : 'code-docker-dind 사이드카에 받아둔 이미지 목록입니다.'}
      </p>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <Skeleton />
      ) : tab === 'containers' ? (
        <ContainerTable
          containers={containers}
          busy={busy}
          onShowLogs={setLogTarget}
          onInspect={setInspectTarget}
          onAction={handleAction}
        />
      ) : (
        <ImageTable images={images} />
      )}

      {logTarget && (
        <DindLogPanel containerId={logTarget.id} containerName={logTarget.names} onClose={() => setLogTarget(null)} />
      )}
      {inspectTarget && (
        <DindInspectPanel containerId={inspectTarget.id} containerName={inspectTarget.names} onClose={() => setInspectTarget(null)} />
      )}
    </section>
  )
}
