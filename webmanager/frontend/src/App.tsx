import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { SidebarContainer } from './components/Layout/SidebarContainer'
import { SECTIONS } from './components/Layout/sections'
import type { SectionId } from './components/Layout/sections'
import { Supervisor } from './components/Supervisor/Supervisor'
import { SshKeys } from './components/SshKeys/SshKeys'
import { GitConfig } from './components/GitConfig/GitConfig'
import { RouterFrame } from './components/RouterEmbed/RouterFrame'
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

function isSectionId(v: string | null): v is SectionId {
  return SECTIONS.some((s) => s.id === v)
}

// Sections that render RouterFrame (a live <iframe> embed - see
// components/RouterEmbed/RouterFrame.tsx). Switching *into* one of these
// mounts an iframe that wasn't there before the transition started, which
// viewTransition.ts's own iframe-presence guard can't detect (it only sees
// the DOM as it exists at call time, before the update runs) - so this
// direction needs an explicit check here instead. See viewTransition.ts's
// own comment for the crash this works around.
const IFRAME_SECTIONS = new Set<SectionId>(['dev-proxy', 'app-routes', 'tailscale', 'dns', 'net'])

// Splits pathname into {root, section} the same way router/frontend's own
// App.tsx does (see its splitPath doc comment for the full reasoning) - only
// looks at the last path segment, so this works unmodified whether the
// build's absolute `/manager/` base or dev's `/` base is in effect. Kept as
// a near-duplicate rather than a shared util since router/frontend and
// webmanager are separate Vite apps with genuinely different Tab/SectionId
// types - see root CLAUDE.md's "sidebar reuse" note on why a shared UI
// package would need real work, not just moving this one function.
function splitPath(pathname: string): { root: string; section: SectionId | null } {
  const segments = pathname.split('/')
  const last = segments[segments.length - 1] || null
  if (isSectionId(last)) {
    return { root: segments.slice(0, -1).join('/') + '/', section: last }
  }
  return { root: pathname.endsWith('/') ? pathname : pathname + '/', section: null }
}

function App() {
  const initialSplit = useMemo(() => splitPath(window.location.pathname), [])
  const rootPath = initialSplit.root
  const [active, setActiveState] = useState<SectionId>(() => initialSplit.section ?? 'supervisor')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  function setActive(id: SectionId) {
    setActiveState(id)
    window.history.pushState(null, '', rootPath + id)
  }

  // Cross-tab "open in ..." actions (Projects/Files/Terminal) - each just
  // stashes a one-shot payload here and switches tabs; the target tab
  // consumes it once on mount (it fully unmounts when not active, see the
  // conditional renders below) and reports back so the payload doesn't
  // linger and reapply on some unrelated later visit to the same tab.
  const [pendingTerminalOpen, setPendingTerminalOpen] = useState<{ cwd?: string; label?: string } | null>(null)
  const [pendingFilesPath, setPendingFilesPath] = useState<string | null>(null)

  function openInTerminal(cwd: string, label?: string) {
    setPendingTerminalOpen({ cwd, label })
    withViewTransition(() => setActive('terminal'))
  }

  function openInFileManager(path: string) {
    setPendingFilesPath(path)
    withViewTransition(() => setActive('files'))
  }

  useEffect(() => {
    function onPopState() {
      setActiveState(splitPath(window.location.pathname).section ?? 'supervisor')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

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
      <SidebarContainer
        active={active}
        onSelect={(id) => (IFRAME_SECTIONS.has(id) ? setActive(id) : withViewTransition(() => setActive(id)))}
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
          {active === 'dev-proxy' && <RouterFrame tab="dev-proxy" />}
          {active === 'app-routes' && <RouterFrame tab="app-routes" />}
          {active === 'tailscale' && <RouterFrame tab="tailscale" />}
          {active === 'dns' && <RouterFrame tab="dns" />}
          {active === 'net' && <RouterFrame tab="net" />}
          {active === 'logs' && (
            <RequiresUnlock>
              <Logs />
            </RequiresUnlock>
          )}
          {active === 'processes' && <Processes />}
          {active === 'projects' && <Projects onOpenTerminal={openInTerminal} onOpenFileManager={openInFileManager} />}
          {active === 'mise' && <Mise />}
          {active === 'dind' && <Dind />}
          {active === 'claude' && <ClaudeCode />}
          {active === 'extensions' && <Extensions />}
          {active === 'terminal' && (
            <RequiresUnlock>
              <Terminal
                initialOpen={pendingTerminalOpen}
                onInitialOpenConsumed={() => setPendingTerminalOpen(null)}
                onOpenFileManager={openInFileManager}
              />
            </RequiresUnlock>
          )}
          {active === 'files' && (
            <Suspense fallback={<Skeleton />}>
              <RequiresUnlock>
                <FileManager
                  initialPath={pendingFilesPath}
                  onInitialPathConsumed={() => setPendingFilesPath(null)}
                  onOpenTerminal={openInTerminal}
                />
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
