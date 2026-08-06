import { useState } from 'react'
import { Status } from './Status'
import { GlobalSettings } from './GlobalSettings'
import { Forwards } from './Forwards'
import { Publish } from './Publish'
import '../common/common.css'
import './Tailscale.css'

type Tab = 'general' | 'network'

// Split into two tabs (matching webmanager's Task Manager 성능/프로세스
// pattern) rather than one long scrolling page - 기본 설정 (global config +
// status/login, and anywhere future account-wide settings would land) and
// 포워드/퍼블리시 (Forwards + Publish) genuinely differ in kind: one is "how
// this container's tailscale identity is configured", the other is "which
// ports cross the tailnet boundary and which direction" - keeping them apart
// avoids implying a relationship that isn't there.
export function Tailscale() {
  const [tab, setTab] = useState<Tab>('general')

  return (
    <section>
      <div className="section-header">
        <h1>Tailscale</h1>
        <div className="tailscale-tabs">
          <button
            type="button"
            className={`tailscale-tab${tab === 'general' ? ' tailscale-tab-active' : ''}`}
            onClick={() => setTab('general')}
          >
            기본 설정
          </button>
          <button
            type="button"
            className={`tailscale-tab${tab === 'network' ? ' tailscale-tab-active' : ''}`}
            onClick={() => setTab('network')}
          >
            포워드 / 퍼블리시
          </button>
        </div>
      </div>
      <p className="section-description">
        {tab === 'general'
          ? '전역 설정과 로그인/연결 상태를 확인합니다.'
          : '외부 tailnet 포트를 이 컨테이너로 끌어오거나(forwards), 로컬 포트를 tailnet에 노출합니다(publish).'}
      </p>
      <div className="warning-note">
        <span aria-hidden="true">⚠</span>
        <span>
          <strong>이 컨테이너(router) 안에서 <code>0.0.0.0</code>/<code>localhost</code>에 바인드된 포트는 규칙 없이도
          tailnet 전체에 같은 포트 번호로 자동 노출</strong>됩니다 (tailscaled netstack의 기본 동작). code-docker의
          sshd 등 다른 컨테이너에서 뜨는 서비스는 tailscaled가 router에서만 실행되므로 이 자동 노출 대상이{' '}
          <strong>아닙니다</strong> — 그 컨테이너들에 접근하려면 아래 forwards/publish를 명시적으로 설정해야 합니다.
          자세한 내용은 레포 루트 <code>docs/tailscale.md</code> 참고.
        </span>
      </div>

      {tab === 'general' ? (
        <>
          <Status />
          <GlobalSettings />
        </>
      ) : (
        <>
          <Forwards />
          <Publish />
        </>
      )}
    </section>
  )
}
