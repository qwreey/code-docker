import { useEffect, useMemo, useState } from 'react'
import { DevProxy } from './components/DevProxy/DevProxy'
import { AppRoutes } from './components/AppRoutes/AppRoutes'
import { Tailscale } from './components/Tailscale/Tailscale'
import { Dns } from './components/Dns/Dns'
import { NetManagement } from './components/NetManagement/NetManagement'
import { RouterAuthPanel, RouterTrustedHostsPanel } from './components/common/RouterAuthPanel'
import { TinyauthUsers } from './components/Tinyauth/TinyauthUsers'
import { RouterUnlockModalHost } from './components/common/UnlockModal'
import { OriginWarningBanner } from './components/common/OriginWarningBanner'
import { listenForEmbedThemeMessages, notifyEmbedReady } from './embedTheme'
import './App.css'

type Tab = 'dev-proxy' | 'app-routes' | 'tailscale' | 'dns' | 'net' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'dev-proxy', label: 'Dev Proxy' },
  { id: 'app-routes', label: 'App Routes' },
  { id: 'tailscale', label: 'Tailscale' },
  { id: 'dns', label: 'DNS' },
  { id: 'net', label: 'Net 관리' },
  { id: 'settings', label: '설정' },
]

function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v)
}

// Splits pathname into {root, tab} - root always ends with a trailing
// slash and is where new tab paths get appended (root + tabId, no
// trailing slash after the id - matters because vite.config.ts's
// `base: './'` resolves every asset path relative to the CURRENT
// document's directory, i.e. everything up to but not including the last
// path segment; a trailing slash after the tab id would shift that
// directory one level deeper and 404 every asset). Works unmodified
// whether this SPA is served from the shared origin's /router/ prefix or
// the root of a dedicated ROUTER_MANAGER_HOSTS domain, since it only ever
// looks at the last segment, never an absolute prefix - and
// router-manager's own staticHandler (static.go) already falls back to
// index.html for any unknown sub-path, so no nginx changes were needed for
// this.
function splitPath(pathname: string): { root: string; tab: Tab | null } {
  const segments = pathname.split('/')
  const last = segments[segments.length - 1] || null
  if (isTab(last)) {
    return { root: segments.slice(0, -1).join('/') + '/', tab: last }
  }
  return { root: pathname.endsWith('/') ? pathname : pathname + '/', tab: null }
}

// router's own standalone management UI, served by router-manager itself at
// /router/ (see router/backend/static.go) - lets App Routes/Dev
// Proxy/Tailscale/tinyauth all be managed without going through webmanager.
// Same components webmanager imports from this package (@code-docker/
// router-frontend), just switched by a plain tab bar instead of
// webmanager's own sidebar.
//
// ?embed=1&tab=<id> (RouterFrame.tsx on the webmanager side, only used once
// ROUTER_MANAGER_HOSTS is configured) hides the header/tab-switcher chrome
// below and pins the view to one tab - the point is for this to render as a
// drop-in replacement for webmanager's own same-origin <DevProxy />-style
// embed, just running on router-manager's own dedicated origin so its
// unlock cookie doesn't share webmanager's origin. embedTheme.ts's
// ?theme=/postMessage handling is unconditional (harmless outside embed
// mode - a standalone visit just never gets a theme message).
function App() {
  const embedParams = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return { embed: params.get('embed') === '1', tab: params.get('tab') }
  }, [])
  const embed = embedParams.embed
  // Captured once at mount, before any pushState below can change
  // window.location - the prefix every tab path gets appended to (e.g.
  // "/router/" or "/", see splitPath's doc comment).
  const initialSplit = useMemo(() => splitPath(window.location.pathname), [])
  const rootPath = initialSplit.root
  // Defaults to 설정 outside embed mode - matches the old standalone /router/
  // page's behavior (it was only ever the auth setup/change page), and
  // RouterAuthSetupBanner still links plain "/router/" expecting to land on
  // the password form. Embed mode defaults to dev-proxy instead, purely so
  // an invalid/missing ?tab= doesn't silently show the password panel inside
  // what's supposed to be a Dev Proxy/App Routes/Tailscale embed. Outside
  // embed mode, a tab already present in the URL (e.g. a reload, or a
  // bookmarked link) wins over that default - see splitPath/setTab below.
  const [tab, setTabState] = useState<Tab>(() => {
    if (embed) return isTab(embedParams.tab) ? embedParams.tab : 'dev-proxy'
    return initialSplit.tab ?? 'settings'
  })

  // Embed mode keeps the existing ?tab= query-string contract with
  // RouterFrame.tsx on the webmanager side instead (see the component doc
  // comment above) - pushState-ing a path there would just desync from
  // what the parent iframe embed expects.
  function setTab(next: Tab) {
    setTabState(next)
    if (!embed) window.history.pushState(null, '', rootPath + next)
  }

  useEffect(() => listenForEmbedThemeMessages(), [])
  // Fires after this render has committed (and painted) - a reasonable
  // proxy for "ready" without needing to track every child component's own
  // data-loading state. See notifyEmbedReady's own doc comment.
  useEffect(() => {
    if (embed) notifyEmbedReady()
  }, [embed])

  // Keeps the tab in sync with browser back/forward navigation.
  useEffect(() => {
    if (embed) return
    function onPopState() {
      setTabState(splitPath(window.location.pathname).tab ?? 'settings')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [embed])

  return (
    <div className="router-app">
      {!embed && (
        <header className="router-app-header">
          <h1>router</h1>
          <nav className="router-app-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.id === tab ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small'}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>
      )}
      <main className="router-app-main">
        <OriginWarningBanner />
        {tab === 'dev-proxy' && <DevProxy />}
        {tab === 'app-routes' && <AppRoutes />}
        {tab === 'tailscale' && <Tailscale />}
        {tab === 'dns' && <Dns />}
        {tab === 'net' && <NetManagement />}
        {tab === 'settings' && (
          <section>
            <div className="section-header">
              <h1>설정</h1>
            </div>
            <p className="section-description">router-manager 자체 인증, 전용 도메인, tinyauth 사용자를 관리합니다.</p>
            <RouterAuthPanel />
            <RouterTrustedHostsPanel />
            <TinyauthUsers />
          </section>
        )}
      </main>
      <RouterUnlockModalHost />
    </div>
  )
}

export default App
