import { useState } from 'react'
import { Sidebar } from './components/Layout/Sidebar'
import type { SectionId } from './components/Layout/sections'
import { Supervisor } from './components/Supervisor/Supervisor'
import { SshKeys } from './components/SshKeys/SshKeys'
import { GitConfig } from './components/GitConfig/GitConfig'
import { Tailscale } from './components/Tailscale/Tailscale'
import { Logs } from './components/Logs/Logs'
import { Processes } from './components/Processes/Processes'
import { ClaudeCode } from './components/ClaudeCode/ClaudeCode'
import { Placeholder } from './components/Placeholder/Placeholder'
import './App.css'

const PLACEHOLDER_INFO: Record<string, { title: string; note: string }> = {
  mise: {
    title: 'mise',
    note: '설치된 tool/version 목록 조회 및 mise use -g 실행 예정.',
  },
  dind: {
    title: 'Docker (dind)',
    note: 'dind 컨테이너/이미지 목록 조회 및 시작/정지/삭제 관리 예정.',
  },
  terminal: {
    title: 'Terminal',
    note: 'PTY + WebSocket 기반 브라우저 터미널 예정.',
  },
}

function App() {
  const [active, setActive] = useState<SectionId>('supervisor')

  return (
    <div className="app-shell">
      <Sidebar active={active} onSelect={setActive} />
      <main className="app-content">
        {active === 'supervisor' && <Supervisor />}
        {active === 'ssh-keys' && <SshKeys />}
        {active === 'git-config' && <GitConfig />}
        {active === 'tailscale' && <Tailscale />}
        {active === 'logs' && <Logs />}
        {active === 'processes' && <Processes />}
        {active === 'claude' && <ClaudeCode />}
        {active in PLACEHOLDER_INFO && (
          <Placeholder title={PLACEHOLDER_INFO[active].title} note={PLACEHOLDER_INFO[active].note} />
        )}
      </main>
    </div>
  )
}

export default App
