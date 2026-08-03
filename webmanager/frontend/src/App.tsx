import { lazy, Suspense, useState } from 'react'
import { Sidebar } from './components/Layout/Sidebar'
import type { SectionId } from './components/Layout/sections'
import { Supervisor } from './components/Supervisor/Supervisor'
import { SshKeys } from './components/SshKeys/SshKeys'
import { GitConfig } from './components/GitConfig/GitConfig'
import { Tailscale } from './components/Tailscale/Tailscale'
import { Logs } from './components/Logs/Logs'
import { Processes } from './components/Processes/Processes'
import { Projects } from './components/Projects/Projects'
import { ClaudeCode } from './components/ClaudeCode/ClaudeCode'
import { Extensions } from './components/Extensions/Extensions'
import { Mise } from './components/Mise/Mise'
import { Dind } from './components/Dind/Dind'
import { Terminal } from './components/Terminal/Terminal'
import { RequiresUnlock } from './components/common/RequiresUnlock'
import { UnlockModalHost } from './components/common/UnlockModal'
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
        onSelect={setActive}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="app-content">
        {active === 'supervisor' && <Supervisor />}
        {active === 'ssh-keys' && <SshKeys />}
        {active === 'git-config' && <GitConfig />}
        {active === 'tailscale' && <Tailscale />}
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
        {active === 'terminal' && <Terminal />}
        {active === 'files' && (
          <Suspense fallback={<p className="empty-state">불러오는 중...</p>}>
            <RequiresUnlock>
              <FileManager />
            </RequiresUnlock>
          </Suspense>
        )}
      </main>
      <UnlockModalHost />
    </div>
  )
}

export default App
