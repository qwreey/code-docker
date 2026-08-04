import { lazy, Suspense, useState } from 'react'
import { Sidebar } from './components/Layout/Sidebar'
import type { SectionId } from './components/Layout/sections'
import { Supervisor } from './components/Supervisor/Supervisor'
import { SshKeys } from './components/SshKeys/SshKeys'
import { GitConfig } from './components/GitConfig/GitConfig'
import { Tailscale } from './components/Tailscale/Tailscale'
import { DevProxy } from './components/DevProxy/DevProxy'
import { Logs } from './components/Logs/Logs'
import { Processes } from './components/Processes/Processes'
import { Projects } from './components/Projects/Projects'
import { ClaudeCode } from './components/ClaudeCode/ClaudeCode'
import { Extensions } from './components/Extensions/Extensions'
import { Mise } from './components/Mise/Mise'
import { Dind } from './components/Dind/Dind'
import { Terminal } from './components/Terminal/Terminal'
import { Sessions } from './components/Sessions/Sessions'
import { RequiresUnlock } from './components/common/RequiresUnlock'
import { UnlockModalHost } from './components/common/UnlockModal'
import { EnvVersionBanner } from './components/common/EnvVersionBanner'
import { Skeleton } from './components/common/Skeleton'
import { withViewTransition } from './utils/viewTransition'
import './App.css'

// FileManager pulls in the CodeMirror editor chunk and is a sizable feature
// on its own — lazy-load the tab itself so it's only fetched once selected.
const FileManager = lazy(() =>
  import('./components/FileManager/FileManager').then((module) => ({ default: module.FileManager })),
)

function App() {
  const [active, setActive] = useState<SectionId>('supervisor')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="app-shell">
      <div className="mobile-topbar">
        <button
          type="button"
          className="hamburger-btn"
          aria-label={sidebarOpen ? '메뉴 닫기' : '메뉴 열기'}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <span className="mobile-topbar-title">webmanager</span>
      </div>
      <Sidebar
        active={active}
        onSelect={(id) => withViewTransition(() => setActive(id))}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {/* EnvVersionBanner lives here, above .app-content rather than inside
          it, deliberately — Terminal.css's full-bleed layout relies on
          .terminal-section being .app-content's *only* child (negative
          margins that cancel .app-content's own padding), and having the
          banner as a leading sibling *inside* .app-content broke that
          assumption: the negative top margin pulled the terminal topbar up
          into the banner's box instead of appearing below it. Keeping the
          banner in its own flex row above .app-content (see App.css's
          .app-main) means it's never in a position the negative margin can
          reach, for every tab, not just Terminal. */}
      <div className="app-main">
        <EnvVersionBanner />
        <main className="app-content">
          {active === 'supervisor' && <Supervisor />}
          {active === 'ssh-keys' && <SshKeys />}
          {active === 'git-config' && <GitConfig />}
          {active === 'tailscale' && <Tailscale />}
          {active === 'dev-proxy' && <DevProxy />}
          {active === 'logs' && (
            <RequiresUnlock>
              <Logs />
            </RequiresUnlock>
          )}
          {active === 'processes' && <Processes />}
          {active === 'projects' && <Projects />}
          {active === 'mise' && <Mise />}
          {active === 'dind' && <Dind />}
          {active === 'claude' && <ClaudeCode />}
          {active === 'extensions' && <Extensions />}
          {active === 'terminal' && (
            <RequiresUnlock>
              <Terminal />
            </RequiresUnlock>
          )}
          {active === 'files' && (
            <Suspense fallback={<Skeleton />}>
              <RequiresUnlock>
                <FileManager />
              </RequiresUnlock>
            </Suspense>
          )}
          {active === 'sessions' && (
            <RequiresUnlock>
              <Sessions />
            </RequiresUnlock>
          )}
        </main>
      </div>
      <UnlockModalHost />
    </div>
  )
}

export default App
