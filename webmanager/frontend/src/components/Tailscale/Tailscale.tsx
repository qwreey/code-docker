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
      <Status />
      <GlobalSettings />
      <Forwards />
      <Publish />
    </section>
  )
}
