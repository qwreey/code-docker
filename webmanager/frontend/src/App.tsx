import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { CollapseChevron } from './components/common/CollapseChevron'
import { FileManagerDialog } from './components/FileManager/FileManagerDialog'
import { ProjectInfoDialog } from './components/Projects/ProjectInfoDialog'
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
import { Fonts } from './components/Fonts/Fonts'
import { FileShare } from './components/FileShare/FileShare'
import { Sessions } from './components/Sessions/Sessions'
import { RequiresUnlock } from './components/common/RequiresUnlock'
import { UnlockModalHost } from './components/common/UnlockModal'
import { EnvVersionBanner } from './components/common/EnvVersionBanner'
import { RouterAuthSetupBanner } from './components/common/RouterAuthSetupBanner'
import { Skeleton } from './components/common/Skeleton'
import { useAuthStatus } from './components/common/useAuthStatus'
import { ensureUnlocked } from './components/common/useUnlockGate'
import { withViewTransition } from './utils/viewTransition'
import { useEmbedEscapeClose } from './utils/embedEscape'
import './App.css'

// FileManager pulls in the CodeMirror editor chunk and is a sizable feature
// on its own — lazy-load the tab itself so it's only fetched once selected.
const FileManager = lazy(() =>
  import('./components/FileManager/FileManager').then((module) => ({ default: module.FileManager })),
)

function isSectionId(v: string | null): v is SectionId {
  return SECTIONS.some((s) => s.id === v)
}

// Client-side-only UI preference (per webmanager/CLAUDE.md's ground rules) -
// same try/catch-wrapped load/save pattern as theme.ts/Extensions.tsx.
const SIDEBAR_COLLAPSED_KEY = 'webmanager-sidebar-collapsed'

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function saveSidebarCollapsed(collapsed: boolean) {
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
    else localStorage.removeItem(SIDEBAR_COLLAPSED_KEY)
  } catch {
    // best-effort - the choice still applies for this page load either way
  }
}

// Sections that render RouterFrame (a live <iframe> embed - see
// components/RouterEmbed/RouterFrame.tsx). Switching *into* one of these
// mounts an iframe that wasn't there before the transition started, which
// viewTransition.ts's own iframe-presence guard can't detect (it only sees
// the DOM as it exists at call time, before the update runs) - so this
// direction needs an explicit check here instead. See viewTransition.ts's
// own comment for the crash this works around.
const IFRAME_SECTIONS = new Set<SectionId>([
  'dev-proxy',
  'app-routes',
  'vnc',
  'tailscale',
  'dns',
  'net',
  'tinyauth',
  'router-settings',
])

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

// Deep-link query state. The pathname already says which tab is open
// (splitPath above); this carries the one piece of *within*-tab state each of
// three tabs has that is worth surviving a reload or being bookmarked —
// which terminal session, which folder, which project.
//
// replaceState, not pushState: these change as you click around inside a tab,
// and pushing an entry per folder step would redefine the browser's Back
// button as "go up one directory" in Files and "previously selected session"
// in Terminal, which is not what Back means anywhere else in this app.
// Switching tabs drops the query entirely, since setActive pushes a bare
// `rootPath + id` — a ?session= has no meaning on the Files tab.
function writeQuery(key: string, value: string | null) {
  const params = new URLSearchParams(window.location.search)
  if (value) params.set(key, value)
  else params.delete(key)
  const qs = params.toString()
  window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
}

function App() {
  const initialSplit = useMemo(() => splitPath(window.location.pathname), [])
  const initialQuery = useMemo(() => new URLSearchParams(window.location.search), [])
  const rootPath = initialSplit.root
  const [active, setActiveState] = useState<SectionId>(() => initialSplit.section ?? 'supervisor')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed)
  const { status: authStatus } = useAuthStatus()

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((v) => {
      const next = !v
      saveSidebarCollapsed(next)
      return next
    })
  }

  function setActive(id: SectionId) {
    setActiveState(id)
    window.history.pushState(null, '', rootPath + id)
  }

  // Cross-tab "open in ..." actions (Projects/Files/Terminal) - each just
  // stashes a one-shot payload here and switches tabs; the target tab
  // consumes it once on mount (it fully unmounts when not active, see the
  // conditional renders below) and reports back so the payload doesn't
  // linger and reapply on some unrelated later visit to the same tab.
  const [pendingTerminalOpen, setPendingTerminalOpen] = useState<{
    cwd?: string
    label?: string
    command?: string
    session?: string
  } | null>(null)
  const [pendingFilesPath, setPendingFilesPath] = useState<string | null>(
    () => (initialSplit.section === 'files' ? initialQuery.get('path') : null),
  )
  const [pendingProjectPath, setPendingProjectPath] = useState<string | null>(
    () => (initialSplit.section === 'projects' ? initialQuery.get('project') : null),
  )
  // Only meaningful for the very first render of the Terminal tab — see
  // Terminal.tsx's restoreSession prop for why a URL-supplied session name
  // must be verified rather than selected blind.
  const [restoreTerminalSession, setRestoreTerminalSession] = useState<string | null>(
    () => (initialSplit.section === 'terminal' ? initialQuery.get('session') : null),
  )
  // The file browser as an overlay over the current tab (see
  // FileManagerDialog). '' means "the default root", matching FileManager's
  // own null-path convention, since null already means "closed" here.
  const [filesDialogPath, setFilesDialogPath] = useState<string | null>(null)
  // Not a cross-tab payload like the three above — this one opens a dialog
  // in place (see ProjectInfoDialog), which is the whole point: checking
  // which project the current shell sits in shouldn't navigate you out of
  // the terminal you were watching.
  const [projectInfoPath, setProjectInfoPath] = useState<string | null>(null)

  // command, when given, is typed into the new session's shell as if the
  // user had entered it (see termsession.CreateOptions.InitialCommand) —
  // that's how the session log's "resume this conversation" action opens a
  // terminal already running `claude --resume <id>`.
  function openInTerminal(cwd: string, label?: string, command?: string) {
    setProjectInfoPath(null)
    setPendingTerminalOpen({ cwd, label, command })
    withViewTransition(() => setActive('terminal'))
  }

  // Selects an already-open session by name instead of creating a new one -
  // used by the Projects detail sheet's "이 프로젝트에서 열린 세션" panel to
  // jump back to a session rather than spawning a duplicate.
  function openTerminalSession(name: string) {
    setProjectInfoPath(null)
    setPendingTerminalOpen({ session: name })
    withViewTransition(() => setActive('terminal'))
  }

  function openInFileManager(path: string) {
    setPendingFilesPath(path)
    withViewTransition(() => setActive('files'))
  }

  // The overlay variant, used from the Terminal tab: same reasoning as
  // openProjectInfo above — looking at a file an agent just wrote shouldn't
  // cost you the terminal you were watching.
  function openFileManagerOverlay(path: string) {
    setFilesDialogPath(path)
  }

  const handleActiveSessionChange = useCallback((name: string | null) => {
    writeQuery('session', name)
  }, [])

  const handleFilesPathChange = useCallback((path: string | null) => {
    writeQuery('path', path)
  }, [])

  const handleSelectedProjectChange = useCallback((path: string | null) => {
    writeQuery('project', path)
  }, [])

  // Full Projects tab, with the managing actions ProjectInfoDialog leaves
  // out (rescan, reclaimable-folder deletion, project deletion).
  function openProject(path: string) {
    setProjectInfoPath(null)
    setPendingProjectPath(path)
    withViewTransition(() => setActive('projects'))
  }

  // Gated once here, before the dialog opens, so ProjectTerminalSessions and
  // ProjectSessionHistory (rendered inside ProjectInfoDialog) see an
  // already-unlocked cookie instead of each popping its own prompt - same
  // reasoning as ProjectTable.tsx's openDetails, see useUnlockGate.ts.
  async function openProjectInfo(path: string) {
    if (!(await ensureUnlocked(authStatus))) return
    setProjectInfoPath(path)
  }

  useEffect(() => {
    function onPopState() {
      setActiveState(splitPath(window.location.pathname).section ?? 'supervisor')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEmbedEscapeClose()

  return (
    /* The Terminal tab hides the app's own mobile top bar and adopts its
       hamburger into its own header row (Terminal.tsx / Terminal.css) — with
       a phone keyboard up there is very little height left, and a whole bar
       carrying nothing but a menu button is the cheapest thing to give up. */
    <div className={`app-shell${active === 'terminal' ? ' app-shell-terminal' : ''}`}>
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
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
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
      {/* Collapsed-sidebar affordance. This used to be a full-width top bar
          inside .app-main, which bought back the sidebar's 220px of width by
          permanently spending ~48px of height — a bad trade on a desktop
          screen, which is wider than it is tall. A narrow full-height strip
          at the left edge costs no vertical space at all. Desktop-only; the
          mobile drawer has its own .mobile-topbar hamburger (see App.css). */}
      {sidebarCollapsed && (
        <button
          type="button"
          className="sidebar-rail"
          aria-label="사이드바 펼치기"
          aria-expanded={false}
          title="사이드바 펼치기"
          onClick={toggleSidebarCollapsed}
        >
          <span className="sidebar-rail-handle">
            <CollapseChevron open={false} />
          </span>
        </button>
      )}
      <div className="app-main">
        <EnvVersionBanner />
        <RouterAuthSetupBanner />
        <main className="app-content">
          {active === 'supervisor' && <Supervisor />}
          {active === 'ssh-keys' && <SshKeys />}
          {active === 'git-config' && <GitConfig />}
          {active === 'dev-proxy' && <RouterFrame tab="dev-proxy" />}
          {active === 'app-routes' && <RouterFrame tab="app-routes" />}
          {active === 'vnc' && <RouterFrame tab="vnc" />}
          {active === 'tailscale' && <RouterFrame tab="tailscale" />}
          {active === 'dns' && <RouterFrame tab="dns" />}
          {active === 'net' && <RouterFrame tab="net" />}
          {active === 'tinyauth' && <RouterFrame tab="tinyauth" />}
          {active === 'router-settings' && <RouterFrame tab="settings" />}
          {active === 'logs' && (
            <RequiresUnlock>
              <Logs />
            </RequiresUnlock>
          )}
          {active === 'processes' && <Processes />}
          {active === 'projects' && (
            <Projects
              onOpenTerminal={openInTerminal}
              onOpenFileManager={openInFileManager}
              onOpenTerminalSession={openTerminalSession}
              initialProjectPath={pendingProjectPath}
              onInitialProjectPathConsumed={() => setPendingProjectPath(null)}
              onSelectedProjectChange={handleSelectedProjectChange}
            />
          )}
          {active === 'mise' && <Mise />}
          {active === 'dind' && <Dind />}
          {active === 'claude' && <ClaudeCode onOpenTerminal={openInTerminal} />}
          {active === 'extensions' && <Extensions />}
          {active === 'terminal' && (
            <RequiresUnlock>
              <Terminal
                initialOpen={pendingTerminalOpen}
                onInitialOpenConsumed={() => setPendingTerminalOpen(null)}
                onOpenFileManager={openFileManagerOverlay}
                onOpenProject={openProjectInfo}
                onToggleSidebar={() => setSidebarOpen((v) => !v)}
                restoreSession={restoreTerminalSession}
                onRestoreSessionConsumed={() => setRestoreTerminalSession(null)}
                onActiveSessionChange={handleActiveSessionChange}
              />
            </RequiresUnlock>
          )}
          {active === 'fonts' && <Fonts />}
          {active === 'files' && (
            <Suspense fallback={<Skeleton />}>
              <RequiresUnlock>
                <FileManager
                  initialPath={pendingFilesPath}
                  onInitialPathConsumed={() => setPendingFilesPath(null)}
                  onOpenTerminal={openInTerminal}
                  onPathChange={handleFilesPathChange}
                />
              </RequiresUnlock>
            </Suspense>
          )}
          {/* Every /api/webdav endpoint is gated (including the GET — see
              handlers_webdav.go), so this is a whole-tab gate rather than
              relying on the client's 401 interceptor per request. */}
          {active === 'file-share' && (
            <RequiresUnlock>
              <FileShare />
            </RequiresUnlock>
          )}
          {active === 'sessions' && (
            <RequiresUnlock>
              <Sessions />
            </RequiresUnlock>
          )}
        </main>
      </div>
      <FileManagerDialog
        path={filesDialogPath}
        onClose={() => setFilesDialogPath(null)}
        onOpenTerminal={openInTerminal}
        onOpenInFilesTab={(path) => {
          setPendingFilesPath(path)
          withViewTransition(() => setActive('files'))
        }}
      />
      <ProjectInfoDialog
        path={projectInfoPath}
        onClose={() => setProjectInfoPath(null)}
        onOpenInProjectsTab={openProject}
        onOpenTerminal={openInTerminal}
        onOpenTerminalSession={openTerminalSession}
      />
      <UnlockModalHost />
    </div>
  )
}

export default App
