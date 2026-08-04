import { useState } from 'react'
import { Status } from './Status'
import { GlobalSettings } from './GlobalSettings'
import { Forwards } from './Forwards'
import { Publish } from './Publish'
import '../common/common.css'
import './Tailscale.css'

type Tab = 'general' | 'network'

// Split into two tabs (matching Task Manager's 성능/프로세스 pattern) rather
// than one long scrolling page - 기본 설정 (global config + status/login, and
// anywhere future account-wide settings would land) and 포워드/퍼블리시
// (Forwards + Publish) genuinely differ in kind: one is "how this container's
// tailscale identity is configured", the other is "which ports cross the
// tailnet boundary and which direction" - keeping them apart avoids implying
// a relationship that isn't there.
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
          <strong>sshd(22)는 아래 설정과 무관하게 항상 tailnet 전체에 자동 노출</strong>됩니다 (호스트 포트
          퍼블리시 때문에 <code>0.0.0.0</code>에 바인드되어야 하고, tailscaled는 규칙 없는 포트도 같은 번호로
          자동 연결해주기 때문입니다) — 다만 키 인증만 통과하면 접근 가능해서(비밀번호 로그인 없음) 위험도는
          낮게 보고 있습니다. <strong>tailnet 관리 콘솔(ACL)에서 code-docker 태그로 접근 가능한 포트를 22로
          제한하는 걸 권장합니다.</strong> code-server/webmanager는 이제 전용 tailscale IP(<code>private</code>
          호스트네임, <code>CODE_SERVER_BIND_ADDR</code>/<code>WEBMANAGER_ADDR</code>)에 바인드되고 in-container
          nginx도 tailscale의 자동 loopback 포워딩 경로를 거부해서 이 자동 노출 대상이 아니지만, code-server는
          여전히 <code>auth: none</code>이고 webmanager도 자체 로그인이 없으니 — 컨테이너 앞단 리버스 프록시의
          forward-auth는 여전히 필수입니다. 자세한 내용은 레포 루트 <code>docs/tailscale.md</code>의 "보안:
          tailnet ACL 설정" 절 참고.
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
