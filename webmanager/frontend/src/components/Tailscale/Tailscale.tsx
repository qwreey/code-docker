import { Status } from './Status'
import { GlobalSettings } from './GlobalSettings'
import { Forwards } from './Forwards'
import { Publish } from './Publish'
import '../common/common.css'
import './Tailscale.css'

export function Tailscale() {
  return (
    <section>
      <div className="section-header">
        <h1>Tailscale</h1>
      </div>
      <p className="section-description">
        아래 상태 카드는 조회 전용입니다 — forwards/publish 설정을 관리하려면 이어지는 섹션을 사용하세요.
      </p>
      <div className="warning-note">
        <span aria-hidden="true">⚠</span>
        <span>
          sshd(22), code-server(80), webmanager(81)는 아래 설정과 무관하게 <strong>항상 tailnet 전체에 자동
          노출</strong>됩니다 (전부 <code>0.0.0.0</code>에 바인드되어 있고, tailscaled는 규칙 없는 포트도 같은
          번호로 자동 연결해주기 때문입니다). code-server는 <code>auth: none</code>, webmanager는 자체 로그인이
          없으므로 — tailnet에 들어가는 순간 인증 없이 SSH/git credential까지 접근 가능한 사람이 tailnet 전체로
          넓어진다는 뜻입니다. <strong>tailnet 관리 콘솔(ACL)에서 code-docker 태그로 접근 가능한 포트를 22/80/81로
          반드시 제한하세요</strong> — 선택 사항이 아닙니다.
        </span>
      </div>
      <Status />
      <GlobalSettings />
      <Forwards />
      <Publish />
    </section>
  )
}
