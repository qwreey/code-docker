import { useEffect, useRef, useState, type ComponentType } from 'react'
import { Skeleton } from '@code-docker/router-frontend'
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
  tab: 'dev-proxy' | 'app-routes' | 'tailscale' | 'dns'
  // Same-origin fallback, rendered directly (no iframe) when no dedicated
  // ROUTER_MANAGER_HOSTS domain is configured - identical to how this tab
  // rendered before RouterFrame existed.
  Direct: ComponentType
}

/**
 * Renders a router-manager tab either directly (same origin as webmanager,
 * today's default) or via a cross-origin iframe into a dedicated
 * ROUTER_MANAGER_HOSTS domain, once one is configured - see docs/router.md's
 * "보안: 공유 origin과 전용 도메인". The iframe case is what actually closes
 * the ambient-cookie gap for these tabs specifically: same-origin embedding
 * (the Direct fallback) means router-manager's unlock cookie is reachable by
 * anything else running on webmanager's own origin, no matter how it got
 * there (XSS, a poisoned agent). A genuinely cross-origin iframe can't be
 * reached that way - the parent page has no DOM/cookie access into it at all.
 */
export function RouterFrame({ tab, Direct }: RouterFrameProps) {
  const trustedHosts = useRouterTrustedHosts()

  if (trustedHosts === null) return <Skeleton />
  if (trustedHosts.length === 0) return <Direct />
  return <RouterIframe host={trustedHosts[0]} tab={tab} />
}

function RouterIframe({ host, tab }: { host: string; tab: RouterFrameProps['tab'] }) {
  const { theme } = useTheme()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)

  // src is only computed once per (host, tab) - the initial ?theme= just
  // avoids a flash on first paint (see router/frontend/src/embedTheme.ts);
  // live theme changes go through postMessage below instead of reloading
  // the iframe by changing its src.
  const [src] = useState(() => `https://${host}/router/?embed=1&tab=${tab}&theme=${theme}`)

  useEffect(() => {
    const hardCap = setTimeout(() => setLoaded(true), LOAD_HARD_CAP_MS)
    return () => clearTimeout(hardCap)
  }, [])

  // The precise signal (router/frontend/src/embedTheme.ts's
  // notifyEmbedReady, sent once its App has actually mounted/painted) - the
  // onLoad+200ms/3s-hard-cap timers above stay as fallbacks for older
  // builds or if this message never arrives, but this is what normally
  // hides the skeleton in practice, well before a fixed timer would. event
  // .origin is checked here (unlike the theme listener on the receiving
  // end) since this side genuinely knows which host it's talking to.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== `https://${host}`) return
      const data = event.data
      if (data && typeof data === 'object' && data.source === MESSAGE_SOURCE && data.type === 'ready') {
        setLoaded(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [host])

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ source: MESSAGE_SOURCE, type: 'theme', theme }, `https://${host}`)
  }, [theme, host])

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
