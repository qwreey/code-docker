import { useEffect, useRef, useState } from 'react'
import { Skeleton } from '../common/Skeleton'
import { useTheme } from '../../useTheme'
import { useRouterTrustedHosts } from './useRouterTrustedHosts'
import './RouterFrame.css'

const MESSAGE_SOURCE = 'code-docker-router-embed'

// Fallbacks only - the normal path is the 'ready' postMessage below, sent
// the moment the embedded App has actually mounted. These exist for
// robustness (an older router-manager build with no notifyEmbedReady yet,
// or the message just not arriving for some reason), not as the primary
// signal.
//
// Skeleton-hide delay after the iframe's own onLoad fires (lets its inner
// React app get its first paint in) - not trying to be exact, just avoiding
// a jarring snap from skeleton to half-rendered content.
const LOAD_SETTLE_MS = 200
// Hard cap regardless of onLoad - weak/slow connections can leave onLoad
// pending far longer than a normal load, and an indefinite skeleton reads
// as broken. Reveals the iframe as-is (it'll keep loading/painting normally,
// same as any other slow page) rather than blocking on a signal that may
// never come promptly.
const LOAD_HARD_CAP_MS = 3000

interface RouterFrameProps {
  tab: 'dev-proxy' | 'app-routes' | 'tailscale' | 'dns' | 'net' | 'tinyauth' | 'settings'
}

/**
 * Renders a router-manager tab as an iframe into router's own `/router/`
 * page - either same-origin (default, no ROUTER_MANAGER_HOSTS configured)
 * or cross-origin into a dedicated domain once one is (see docs/router.md's
 * "보안: 공유 origin과 전용 도메인"). Always an iframe now, never a
 * same-origin direct render of @code-docker/router-frontend components -
 * see .claude/backlog/router-frontend-decouple-plan.md for why webmanager
 * used to have a `Direct` fallback here and why it was dropped
 * (2026-08-08): webmanager no longer imports any router-specific component
 * at all, only this one iframe wrapper, which is what actually makes router
 * an optional/opt-out integration rather than a hard build-time dependency.
 * The cross-origin case is still what closes the ambient-cookie gap for
 * these tabs specifically - a genuinely cross-origin iframe has no DOM/
 * cookie access into router-manager at all, unlike a same-origin embed.
 */
export function RouterFrame({ tab }: RouterFrameProps) {
  const trustedHosts = useRouterTrustedHosts()

  if (trustedHosts === null) return <Skeleton />
  return <RouterIframe host={trustedHosts[0]} tab={tab} />
}

// host is undefined when no dedicated ROUTER_MANAGER_HOSTS domain is
// configured - the iframe then just points at this same origin's own
// /router/ path instead of a cross-origin one.
function RouterIframe({ host, tab }: { host?: string; tab: RouterFrameProps['tab'] }) {
  const { theme } = useTheme()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)

  // src is only computed once per (host, tab) - the initial ?theme= just
  // avoids a flash on first paint (see router/frontend/src/embedTheme.ts);
  // live theme changes go through postMessage below instead of reloading
  // the iframe by changing its src.
  const [src] = useState(() => {
    const base = host ? `https://${host}` : ''
    return `${base}/router/?embed=1&tab=${tab}&theme=${theme}`
  })
  const targetOrigin = host ? `https://${host}` : window.location.origin

  useEffect(() => {
    const hardCap = setTimeout(() => setLoaded(true), LOAD_HARD_CAP_MS)
    return () => clearTimeout(hardCap)
  }, [])

  // The precise signal (router/frontend/src/embedTheme.ts's
  // notifyEmbedReady, sent once its App has actually mounted/painted) - the
  // onLoad+200ms/3s-hard-cap timers above stay as fallbacks for older
  // builds or if this message never arrives, but this is what normally
  // hides the skeleton in practice, well before a fixed timer would.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== targetOrigin) return
      const data = event.data
      if (data && typeof data === 'object' && data.source === MESSAGE_SOURCE && data.type === 'ready') {
        setLoaded(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [targetOrigin])

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ source: MESSAGE_SOURCE, type: 'theme', theme }, targetOrigin)
  }, [theme, targetOrigin])

  function handleLoad() {
    setTimeout(() => setLoaded(true), LOAD_SETTLE_MS)
  }

  return (
    <div className="router-frame-wrap">
      {!loaded && (
        <div className="router-frame-skeleton-overlay">
          <Skeleton />
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={src}
        onLoad={handleLoad}
        className="router-frame-iframe"
        title={`router-manager: ${tab}`}
      />
    </div>
  )
}
