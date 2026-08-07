import { useState } from 'react'
import { DevProxy } from './components/DevProxy/DevProxy'
import { AppRoutes } from './components/AppRoutes/AppRoutes'
import { Tailscale } from './components/Tailscale/Tailscale'
import { RouterAuthPanel } from './components/common/RouterAuthPanel'
import { TinyauthUsers } from './components/Tinyauth/TinyauthUsers'
import { RouterUnlockModalHost } from './components/common/UnlockModal'
import './App.css'

type Tab = 'dev-proxy' | 'app-routes' | 'tailscale' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'dev-proxy', label: 'Dev Proxy' },
  { id: 'app-routes', label: 'App Routes' },
  { id: 'tailscale', label: 'Tailscale' },
  { id: 'settings', label: '설정' },
]

// router's own standalone management UI, served by router-manager itself at
// /router/ (see router/backend/static.go) - lets App Routes/Dev
// Proxy/Tailscale/tinyauth all be managed without going through webmanager.
// Same components webmanager imports from this package (@code-docker/
// router-frontend), just switched by a plain tab bar instead of
// webmanager's own sidebar.
function App() {
  // Defaults to 설정 - matches the old standalone /router/ page's behavior
  // (it was only ever the auth setup/change page), and RouterAuthSetupBanner
  // still links plain "/router/" expecting to land on the password form.
  const [tab, setTab] = useState<Tab>('settings')

  return (
    <div className="router-app">
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
      <main className="router-app-main">
        {tab === 'dev-proxy' && <DevProxy />}
        {tab === 'app-routes' && <AppRoutes />}
        {tab === 'tailscale' && <Tailscale />}
        {tab === 'settings' && (
          <>
            <RouterAuthPanel />
            <TinyauthUsers />
          </>
        )}
      </main>
      <RouterUnlockModalHost />
    </div>
  )
}

export default App
