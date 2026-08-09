import { Outbound } from './Outbound'
import { Forwards } from './Forwards'
import '../common/common.css'
import './NetManagement.css'

// Outbound CIDR 규칙과 인바운드 포트포워딩은 하나의 탭으로 묶여 있다 - forward
// 대상의 IP 자체가 보통 RFC1918 대역이라 두 설정이 서로 순서/상호작용을 갖기
// 때문(config.default.yaml의 자체 주석 참고). 이전에는 둘 다
// config.override.yaml을 손으로 고치고 컨테이너를 재생성해야만 바뀌었는데, 이제
// 웹에서 바로 관리한다 - 자세한 배경은 docs/egress-netgate.md 참고.
export function NetManagement() {
  return (
    <section>
      <div className="section-header">
        <h1>Net 관리</h1>
      </div>
      <p className="section-description">
        이 라우터를 게이트웨이로 사용하는 컨테이너가 내보내는 트래픽에 대한 CIDR allow/block 규칙과, 호스트 포트를
        내부 네트워크의 컨테이너로 전달하는 포트포워딩을 관리합니다.
      </p>
      <div className="warning-note">
        <span aria-hidden="true">⚠</span>
        <span>
          <strong>같은 내부 네트워크에 직접 붙어 있는 컨테이너끼리의 트래픽은 이 테이블로 제어할 수 없습니다.</strong>{' '}
          같은 서브넷 안에서는 커넥티드 라우트(connected route)를 그대로 타기 때문에 FORWARD 체인(이 규칙들이
          적용되는 지점) 자체를 거치지 않습니다 - 라우팅 게이트웨이를 경유하지 않으니까요. 즉 아래 outbound
          규칙으로 같은 내부 네트워크에 있는 다른 컨테이너로의 접근을 막을 수는 없고, 오직 외부(인터넷 방향)로
          나가는 트래픽만 이 규칙의 적용을 받습니다.
        </span>
      </div>

      <Forwards />
      <Outbound />
    </section>
  )
}
