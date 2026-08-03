import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { DindContainer, DindImage } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { ContainerTable } from './ContainerTable'
import { ImageTable } from './ImageTable'
import { DindLogPanel } from './DindLogPanel'
import '../Processes/Processes.css'

const POLL_INTERVAL_MS = 5000

type Tab = 'containers' | 'images'

// M1 (read-only): list containers/images + tail logs. Start/stop/remove is
// queued next (M2, with mandatory confirm dialogs); docker run/exec/cp stay
// out of scope indefinitely — see webmanager/.claude/dind-plan.md.
export function Dind() {
  const [tab, setTab] = useState<Tab>('containers')
  const [containers, setContainers] = useState<DindContainer[]>([])
  const [images, setImages] = useState<DindImage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logTarget, setLogTarget] = useState<DindContainer | null>(null)

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
      setLoading(false)
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

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
        <p className="empty-state">불러오는 중...</p>
      ) : tab === 'containers' ? (
        <ContainerTable containers={containers} onShowLogs={setLogTarget} />
      ) : (
        <ImageTable images={images} />
      )}

      {logTarget && (
        <DindLogPanel containerId={logTarget.id} containerName={logTarget.names} onClose={() => setLogTarget(null)} />
      )}
    </section>
  )
}
