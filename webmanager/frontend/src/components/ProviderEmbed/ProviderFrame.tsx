import { useEffect, useRef, useState } from 'react'
import { Skeleton } from '../common/Skeleton'
import { useTheme } from '../../useTheme'
// Same full-bleed box as the router tabs - one set of rules for every
// iframe tab, so a padding change to .app-content is followed in one place.
import '../RouterEmbed/RouterFrame.css'

const MESSAGE_SOURCE = 'code-docker-webmanager'

interface ProviderFrameProps {
  id: string
  title: string
}

/**
 * A provider page (internal/providers on the backend): an attached
 * project's own small management page, reverse-proxied by webmanager at
 * /providers/<id>/ and shown here full-bleed. Unlike RouterFrame there is no
 * 'ready' handshake to wait for - a provider page is plain HTML of its own,
 * so the skeleton lifts on the iframe's load event.
 *
 * The page is same-origin with webmanager. Theme changes are posted to it
 * as {source: 'code-docker-webmanager', type: 'theme', theme} on load and
 * on every change; a page that doesn't listen just ignores them.
 */
export function ProviderFrame({ id, title }: ProviderFrameProps) {
  const { theme } = useTheme()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const src = `${import.meta.env.BASE_URL}providers/${encodeURIComponent(id)}/`

  function postTheme() {
    iframeRef.current?.contentWindow?.postMessage({ source: MESSAGE_SOURCE, type: 'theme', theme }, window.location.origin)
  }

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ source: MESSAGE_SOURCE, type: 'theme', theme }, window.location.origin)
  }, [theme])

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
        onLoad={() => {
          setLoaded(true)
          postTheme()
        }}
        className="router-frame-iframe"
        title={title}
        allow="clipboard-read; clipboard-write"
      />
    </div>
  )
}
