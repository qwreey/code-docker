# roblox-studio-docker 연동: VNC 전용 네트워크 격리 (netgate `forwards:` 다중 네트워크 지원)

## 배경

`~/Projects/roblox-studio-docker` (별도 standalone 프로젝트 — Docker/Wine 기반 Roblox
Studio 컨테이너, GPU passthrough + headless Wayland + wayvnc)를 이 프로젝트와 나란히
띄우기 위한 연결 메커니즘이 이미 준비돼 있다 — `docker-compose.yml` 최상위의
`include: - path: ${EXTRA_INCLUDE:-empty-extra-include.yml}` (이번에 추가됨), 기본값은
아무것도 안 하는 빈 파일. 실제로 연동하려면 로컬에서 `extra-include.yml`을 만들고
(`.gitignore` 대상, 버전관리 안 됨) `builds/roblox-studio-docker/`로 그 repo를 클론한
뒤(`docs/index.md`의 `builds/code-docker` 클론 관례와 동일한 패턴), 아래처럼 그
repo가 이미 준비해 둔 오버레이 파일을 가리키면 된다:

```yaml
# extra-include.yml
include:
  - path: builds/roblox-studio-docker/roblox-studio-code-docker.yml
```

이 메커니즘 자체(`include:` 체인, env var 경로 보간, `networks:`/`ports:` 병합 규칙)는
`roblox-studio-docker` repo 쪽에서 이미 `docker compose config`로 실제 검증까지
마쳤다 — 자세한 내용/실험 기록은 그 repo의 `code-docker-integration-plan.md` 참고
(이 문서와 겹치는 내용은 반복하지 않음).

`roblox-studio-docker` repo에는 이미 `roblox-studio-code-docker.yml`이 있고,
지금은 "Phase 1"만 구현돼 있다 — `studio` 서비스를 `code-docker-internal`에 붙이는
것뿐, VNC 포트(5900)는 여전히 호스트에 직접 게시된 채로 남는다. **이 문서가 다루는
건 그 다음 단계(Phase 2)** — VNC를 `code-docker-internal`이 아니라 별도의 전용
`internal: true` 네트워크에 올려서, code-docker/dind(신뢰 수준이 낮은, 임의
웹브라우징+npm/pip 설치+MCP 툴콜을 하는 에이전트 컨테이너)는 절대 못 붙고
`code-docker-router`만 그 네트워크에 같이 붙어 사람에게 VNC를 중계하게 만드는 것.
(`code-docker`가 code-docker-router를 거치지 않고 직접 인터넷에 못 나가게 만든 것과
같은 "국경은 router만" 원칙을 VNC 접근에도 그대로 적용하는 것 — router가 code-docker
자신보다 신뢰 수준이 높은 별도 컨테이너라는 기존 설계와 일관됨.)

## 목표

`roblox-studio-docker`가 (자기 쪽 `roblox-studio-code-docker.yml`에서) 아래와 같은
compose 조각을 추가하는 것만으로 VNC가 host에 직접 노출되지 않고 오직
`code-docker-router`를 거쳐서만 열리게 만든다:

```yaml
services:
  studio:
    environment:
      VNC_BIND_ALIAS: vnc-only   # roblox-studio-docker의 entrypoint.sh가 이미 지원 -
                                  # 설정하면 wayvnc가 0.0.0.0 대신 이 alias가 resolve된
                                  # IP에만 바인딩한다 (fail-closed: 못 찾으면 exit 1).
    networks:
      - code-docker-internal      # 이미 Phase 1에서 붙어 있음 - 미래 MCP 브리지용
      - roblox-studio-vnc         # 신규 - 아래에서 정의
    ports: !reset []              # host 직접 게시 중단
  code-docker-router:              # 이 프로젝트가 이미 정의한 서비스에 필드만 추가 병합
    networks:
      - roblox-studio-vnc
networks:
  roblox-studio-vnc:
    internal: true
```

(`code-docker-router`처럼 이 오버레이 파일이 직접 정의하지 않은 다른 프로젝트의
서비스에도 `include:` 병합으로 필드를 추가할 수 있다는 것까지 이미 검증됨 — 서비스
이름 기준 병합이라 "이 파일에서 정의한 서비스만" 이라는 제약이 없음.)

`roblox-studio-vnc` 위 IP는 code-docker-router가 그 네트워크에서 `studio`를
이름으로 resolve해서 (netgate `forwards:`를 통해서든, 다른 방식으로든) host의 특정
포트로 중계할 수 있어야 한다. 이 문서는 **그게 실제로 되게 만들기 위해 이 프로젝트
(code-docker) 쪽에서 뭘 확인/고쳐야 하는지**를 정리한 것 — roblox-studio-docker
repo 쪽에서 이 프로젝트 코드를 고칠 방법이 없어서 여기 넘겨진 작업.

## 조사 결과 (이번에 코드 읽고 확인한 것 — 구현 전 재확인 필요)

### 1. netgate `forwards:`의 `target_host` 제약은 코드가 아니라 배포 현실 때문일 가능성이 높음 — 먼저 검증할 것

`router/config/netgate/config.default.yaml`의 기존 주석은 "target_host is any hostname
resolvable on code-docker-internal"이라고 적혀 있지만, 실제 구현
(`router/config/netgate/firewall.default.sh`)을 읽어보면:

```sh
target_ip="$(getent hosts "$target_host" 2>/dev/null | awk '{ print $1; exit }')"
...
iptables -t nat -A NETGATE-PREROUTING -i "$default_iface" -p tcp --dport "$host_port" -j DNAT --to-destination "$target_ip:$target_port"
iptables -A NETGATE-FORWARD -d "$target_ip" -p tcp --dport "$target_port" -j ACCEPT
```

- `target_host` 해석은 `getent hosts`(router 자신의 netns 안에서, Docker 임베디드
  DNS 127.0.0.11을 통해) — 특정 네트워크로 하드코딩된 로직이 아니라 범용 이름 해석.
  Docker의 임베디드 DNS는 그 컨테이너가 붙어있는 **모든** 네트워크의 이름을
  섞어서 응답하는 것으로 알려져 있으므로, router가 `roblox-studio-vnc`에도 붙으면
  거기 붙은 `studio`도 그냥 resolve될 가능성이 높다.
- FORWARD ACCEPT 규칙(`NETGATE-FORWARD` 체인)도 목적지 IP 기준(`-d "$target_ip"`)일
  뿐 특정 인터페이스/네트워크로 제한돼 있지 않다 — 이 체인은 `ensure_jump filter
  FORWARD NETGATE-FORWARD`로 FORWARD 체인 전체에 걸린다(파일 상단 `apply_rules`
  함수).
- 순서 문제도 이미 일반적으로 처리돼 있음: "forwards 항목이 outbound: 블록 규칙보다
  먼저 와야 한다"는 주석(파일 94번째 줄 근처)이 이미 forward별로 지켜지고 있어서,
  `roblox-studio-vnc`가 RFC1918 대역이어도(십중팔구 그럴 것) 기존 RFC1918 블록
  규칙보다 먼저 ACCEPT가 걸릴 것으로 보임 — 신규 네트워크라고 별도 처리 필요 없어
  보임.

**즉, `firewall.default.sh` 자체는 코드 수정 없이 이미 지원할 가능성이 있다** —
`config.default.yaml`의 주석 문구("code-docker-internal에서만")가 코드가 강제하는
제약이 아니라 "지금까지 router가 다른 네트워크에 붙어본 적이 없어서 사실상
code-docker-internal만 가능했다"는 배포 현실을 설명한 것일 수 있음. **구현에 들어가기
전에 반드시 먼저 이 가설을 실제로 검증할 것**: `code-docker-router` 서비스에 테스트용
네트워크를 하나 더 붙여보고, 그 네트워크 위의 다른 컨테이너를 `forwards:` 항목으로
추가한 뒤 실제로 host에서 그 포트로 접속되는지 확인. 되면 아래 2번 항목만 고치면
되고, 안 되면 왜 안 되는지(예: Docker 임베디드 DNS가 실제로는 네트워크별로 격리돼
있어서 기대와 다르게 동작하는 경우 등)부터 다시 진단해야 함.

### 2. `code-docker-netfilter-fix`가 정확히 `code-docker-internal` 하나만 알고 있음 — 이건 확실히 코드 수정 필요

**구현 완료 (2026-08-13)** - 아래 두 항목 모두 반영됨:
`netfilter-fix/fix.sh`가 `CODE_DOCKER_INTERNAL_NETWORK`(기존, 항상 포함) +
`CODE_DOCKER_EXTRA_INTERNAL_NETWORKS`(신규, 공백 구분 목록)를 합쳐 네트워크 이름
목록에 대해 루프 돌도록 일반화했고, `docker-compose.yml`의
`code-docker-netfilter-fix` 서비스가 `CODE_DOCKER_EXTRA_INTERNAL_NETWORKS` 환경변수를
그대로 전달하게 추가했다 (`example-env`에 문서화, `docs/egress-netgate.md`에도 반영).
아래 "실측 검증 결과" 절 참고 - 실측 결과 이번 VNC forward 시나리오 자체엔 이
예외가 필요하지 않은 것으로 확인됐지만, 코드는 harmless한 일반화라 그대로
유지함(기본값 비어있어 기존 배포는 완전히 동일하게 동작).

`netfilter-fix/fix.sh` (`docker-compose.yml`의 `code-docker-netfilter-fix` 서비스,
`network_mode: host` + `NET_ADMIN`으로 호스트 자신의 netfilter를 직접 만짐 — 자세한
배경은 `docs/egress-netgate.md`의 "Docker의 DOCKER-INTERNAL 강제 격리" 절과 그
서비스 자신의 주석 참고):

```sh
NETWORK_NAME="${CODE_DOCKER_INTERNAL_NETWORK:-code-docker-internal}"
...
ensure_rule() {
	bridge="$1"
	...
	nft insert rule ip filter DOCKER-USER iifname "$bridge" accept comment "\"${COMMENT_TAG}\""
}
```

`internal: true`인 네트워크마다 Docker 엔진 자신이 DOCKER-INTERNAL 체인에 그
네트워크의 브리지를 빠져나가는 FORWARD 트래픽을 무조건 차단하는 규칙을 심는다 —
이건 컨테이너 안 iptables(router 자신의 NETGATE-FORWARD 체인)보다 먼저, 호스트
레벨에서 걸리는 차단이라 router 안에서 뭘 어떻게 허용해도 소용없다. 지금은 딱
`code-docker-internal` 하나에 대해서만 이 예외(DOCKER-USER ACCEPT)를 걸어주고 있음
— **`roblox-studio-vnc`도 (VNC를 진짜로 격리하려면 이것도 `internal: true`여야
하므로) 정확히 같은 문제에 부딪히고, 지금 코드로는 예외가 안 걸려서 위 1번을
아무리 잘 고쳐도 router의 forwards ACCEPT 규칙 자체가 호스트 레벨에서 먼저
죽는다.**

필요한 수정 (확실한 작업 항목):
- `netfilter-fix/fix.sh`가 네트워크 이름을 **하나가 아니라 목록**으로 받게 일반화
  (`INTERNAL_NETWORK_NAMES` 같은 공백/콤마 구분 env var, 기본값은 하위호환을 위해
  `code-docker-internal` 하나만). `current_bridge`/`ensure_rule`/
  `cleanup_stale_rules`/`remove_all_own_rules`를 네트워크 이름 목록에 대해 루프
  돌게 바꾸면 됨 — 각 함수가 이미 브리지 이름 단위로 동작하므로 구조를 크게
  바꿀 필요 없이 바깥쪽에 루프 하나만 씌우면 될 것으로 보임.
- `docker-compose.yml`의 `code-docker-netfilter-fix` 서비스
  `environment.CODE_DOCKER_INTERNAL_NETWORK`도 같은 이름의 새 변수로 바뀌거나(또는
  하위호환 위해 유지 + 새 변수 추가), `roblox-studio-docker` 같은 외부 프로젝트가
  자기 네트워크 이름을 이 목록에 추가할 방법이 필요함 — `include:` 체인으로
  `code-docker-netfilter-fix` 서비스의 `environment:`에 병합 추가하는 것도 가능한지
  확인 (Compose의 `environment:`는 키 단위 병합이라 될 것으로 보이지만, 여러
  네트워크 이름을 "목록"으로 표현하는 문자열 포맷(공백 구분 등)과 병합 시 값이
  "교체"되지 지"합쳐지지" 않는다는 점 — 이 하나의 env var 안에 여러 이름을 다
  넣어야 하는 쪽이 최종적으로 값을 쓰게 되므로, roblox-studio-docker 쪽
  오버레이가 이 값을 완전히 새로 쓸 때 code-docker 자신의 기본값
  (`code-docker-internal`)을 빠뜨리지 않게 하는 문서화/가드가 필요함 — 예를 들어
  기본값 자체를 `CODE_DOCKER_INTERNAL_NETWORK:-code-docker-internal}`가 아니라
  값 없이 두고, 이 서비스의 entrypoint/fix.sh 쪽에서 "지정 안 하면
  code-docker-internal은 항상 포함, 추가 목록은 별도 env var로"처럼 두 변수로
  분리하는 게 실수로 기본 네트워크 보호를 빠뜨리는 사고를 막기 더 안전해 보임 —
  실제 설계는 구현자 판단에 맡김, 이건 후보 하나일 뿐).

### 3. `Forwards.tsx`/Net 관리 탭 경고 배너 (참고용, 확실한 필요 여부는 미확인)

`router/.claude/net-auth-expansion-plan.md`에 이미 기록된 경고 배너 문구("
code-docker-internal에 직접 붙어 있는 컨테이너끼리(code-docker↔dind,
code-docker↔router)의 트래픽은 이 테이블로 제어할 수 없습니다 - 같은 서브넷 안에서는
커넥티드 라우트를 그대로 타서 FORWARD 체인 자체를 거치지 않기 때문입니다.")는
code-docker-internal 안에서의 같은-서브넷 트래픽 얘기라 이번 케이스(별도 네트워크
간 forwards)와는 별 상관이 없어 보이지만, 실제 구현하면서 웹 UI로 forwards를 추가할
때 target_host가 code-docker-internal 밖의 이름이어도 UI가 이상하게 동작하지 않는지
(`router/backend/internal/netgate`, `router/frontend/src/components/NetManagement/
Forwards.tsx`) 확인 필요.

## 실측 검증 결과 (2026-08-13)

이 문서의 권장 순서대로 먼저 1번 가설을 실측 검증하고, 2번(netfilter-fix 다중
네트워크 지원)을 구현했다. 검증은 실제 `router` 이미지를 빌드해 `code-docker-router`
+ `code-docker-netfilter-fix`만 단독으로 띄우고, `roblox-studio-vnc`를 흉내낸
`internal: true` 테스트 네트워크(`roblox-studio-vnc-test`)에 router를 추가로 붙인
뒤, 그 네트워크에만 붙은 target 컨테이너로 실제 `forwards:` 항목(router-manager가
읽는 live config, `firewall.default.sh`)을 걸어 host에서 직접 접속해보는 방식으로
진행했다 (임시 리소스는 검증 후 전부 정리함).

**1번 가설(코드 수정 없이 `forwards:`가 code-docker-internal 밖의 target도
지원하는가)은 확인됨 - 단, 예상과 다른 이유로 확인됨:**

- DNS: router가 `roblox-studio-vnc-test`에도 붙어 있으면 `getent hosts <target>`이
  정상적으로 그 네트워크 위의 target IP를 돌려준다 (Docker 임베디드 DNS가 컨테이너가
  붙은 모든 네트워크를 다 뒤져서 응답한다는 가정, 실측으로 확인).
- **의외의 발견: `DOCKER-INTERNAL`/`DOCKER-USER` 체인은 이 트래픽 패턴에서
  아예 관여하지 않는다.** router가 host_port를 받아 그 자리에서 DNAT 후 자기
  자신의 netns 안에서 target으로 라우팅하는 경로는, host↔router, router↔target
  둘 다 "router가 자신이 직접 붙어있는 브리지 위의 살아있는 이웃에게 바로
  전달"하는 패턴이라 - CLAUDE.md에 이미 기록된 "같은 서브넷 트래픽은 커넥티드
  라우트를 타고 FORWARD 체인 자체를 거치지 않는다"는 설명과 동일한 이유로 -
  호스트 레벨 FORWARD/DOCKER-INTERNAL 체인을 아예 거치지 않는다. 실측으로
  `nft`의 `DOCKER-INTERNAL` 카운터가 연결 성공 여부와 무관하게 계속 0으로
  유지되는 것으로 확인 - 즉 **이 특정 트래픽 패턴(router가 직접 붙어있는
  내부망으로의 인바운드 forward)만 놓고 보면 netfilter-fix의 다중 네트워크
  예외가 굳이 없어도 막히지 않는다.**
  (기존에 문서화된 실제 버그 - code-docker 자신의 아웃바운드 인터넷 접근 -
  는 다른 패턴이다: router가 외부에서 받은 응답 트래픽을 code-docker-internal
  "안으로" 릴레이할 때, 그 응답 패킷의 출발지 주소가 code-docker-internal
  서브넷 밖의 주소이기 때문에 걸린다 - 이번 VNC forward 시나리오와는 트래픽
  방향/성격이 다름. 그래서 netfilter-fix 자체는 여전히 유효한 수정이고 코드는
  그대로 두는 게 맞다고 판단함 - 이번 특정 경로엔 불필요할 뿐, 다른 경로/미래
  구성에서 필요해질 수 있고 `CODE_DOCKER_EXTRA_INTERNAL_NETWORKS`가 기본
  비어있어 무해하다.)
- **실제로 막혔던 원인은 완전히 다른 곳이었다 - target 쪽 반환 경로 부재.**
  `roblox-studio-vnc`처럼 `internal: true`인 네트워크는 Docker가 기본 게이트웨이
  라우트를 아예 안 준다 (실측: target 컨테이너의 라우팅 테이블에 자기 서브넷
  connected route 하나만 있고 `default via ...`가 없음). `studio`는 이 계획서의
  "목표" 절 스니펫대로면 `code-docker-internal`/`roblox-studio-vnc` 둘 다
  `internal: true`라 어느 쪽으로도 기본 라우트를 못 받는다 - 즉 SYN은 DNAT을 타고
  target까지 도달하지만(실측 확인: target 인터페이스 RX 카운터 증가), target이
  응답(SYN-ACK)을 원래 클라이언트 주소로 돌려보낼 라우트가 없어서 그냥 행(hang)
  한다. target 컨테이너에 `ip route add <router가 걸친 외부 쪽 서브넷> via
  <router의 roblox-studio-vnc 쪽 IP>`를 수동으로 추가하자 즉시 정상 접속됐다
  (netfilter-fix 다중 네트워크 예외는 걸지 않은 상태에서도 성공 - 위 발견과 일치).

**결론 및 후속 작업 필요 사항 (이 저장소 범위 밖 - roblox-studio-docker 쪽 작업):**
`roblox-studio-code-docker.yml`의 Phase 2 스니펫을 그대로 적용하면 VNC 포트가 열리지
않는다 (host→router→studio SYN은 가지만 응답이 안 옴). 다음 중 하나가 필요:
1. (권장, 이 프로젝트의 기존 관례와 일치) `studio` 컨테이너가 code-docker/dind의
   netinit/dind-entrypoint.sh와 같은 방식으로, 부팅 시 자기 자신의 기본 라우트를
   router 쪽(`roblox-studio-vnc` 위의 router IP)으로 명시적으로 잡아주는 루프를
   추가한다 - roblox-studio-docker 쪽 entrypoint.sh 수정 필요.
2. (대안, 이 저장소 쪽 변경) netgate의 `forwards:` DNAT에 target 네트워크로 나가는
   방향에 한해 SNAT/MASQUERADE를 추가해서, target이 항상 router를 이웃으로만
   보고 응답하면 되게 만든다 - 홈라우터의 NAT 루프백과 동일한 트레이드오프
   (target이 원래 클라이언트의 실제 IP를 못 봄). 이러면 target 쪽에 아무 라우트
   설정도 필요 없어지지만, **기존 forwards:(예: host:8443 -> code-docker:443)의
   동작을 바꾸는 것**이라 - code-docker/dind는 지금 원본 클라이언트 IP를 그대로
   보고 있음 - 신중한 검토와 별도 합의가 필요함, 이번 세션에서 임의로 구현하지
   않음.

이 절 위의 "권장 작업 순서" #1/#4는 이 실측 결과로 대체된 것으로 간주. #2(netfilter-fix)는
이미 구현 완료 (아래 참고). #3(Forwards.tsx)도 확인 완료 - `router/backend/internal/netgate/config.go`의
`validateHost`는 순수 호스트명/IPv4 패턴 검사만 하고 특정 네트워크로 제한하지 않으므로
문제 없음.

**반환 경로 문제에 대한 결정 (2026-08-13, 사용자 확정): 위 옵션 1 채택.**
`studio` 컨테이너에도 code-docker/dind와 동일한 netinit 스타일의 경량 사이드카를
붙여서 부팅 시 자기 기본 라우트를 router 쪽으로 잡게 한다 - SNAT(옵션 2)은 채택
안 함. 근거: `studio`는 애초에 code-docker와 동일한 신뢰 등급의 개발용 컨테이너로
취급해야 한다(Roblox Studio 자체에 HTTPService가 있고 Plugin/콘솔 권한으로 접근
가능하므로 code-docker와 마찬가지로 임의 아웃바운드가 가능한 컨테이너) - `/dev/dri`
접근을 필요로 하는 GPU 워크로드라서 에이전트(code-docker)가 `/dev/dri`에 직접
닿지 않도록 별도 컨테이너로 분리했을 뿐, 신뢰/네트워크 처우는 code-docker와 동일하게
가는 것이 맞다는 판단. 이 저장소의 `netinit/`(own Dockerfile, `network_mode:
service:<target>` + `NET_ADMIN`, `ROUTER_HOSTNAME` 환경변수로 router 별칭을
5초마다 재조정)이 정확히 이 패턴이므로, roblox-studio-docker 쪽에서 그대로
재사용/복제하면 된다 - Docker는 컨테이너를 어떤 네트워크에 붙이든 **네트워크별
alias 설정 없이도 컨테이너 자신의 이름으로 항상 resolve된다**는 것을 이번 실측으로
확인했으므로(테스트에서 `roblox-studio-vnc`에 별도 alias 없이 붙인 컨테이너도
자기 이름으로 정상 resolve됨), router 쪽(`code-docker-router` 서비스, 이
저장소)에는 `roblox-studio-vnc`용 별도 alias를 추가할 필요가 없다 - 컨테이너
이름 `code-docker-router`(또는 `PREFIX`가 붙은 이름)로 바로 resolve된다.
실제 sidecar 구현은 roblox-studio-docker repo 쪽 작업 - 이 repo에서 더 할 일 없음.

## 권장 작업 순서

1. **먼저 1번 가설 검증** — 코드 수정 없이 테스트용 네트워크 하나로 실제 재현해서
   `forwards:`가 정말 code-docker-internal 밖의 target도 되는지 확인. 된다면 이 단계
   전체가 "코드 수정 없음, 문서/config 스키마 정리만"으로 훨씬 작아짐.
2. **`netfilter-fix` 다중 네트워크 지원** (2번, 확실히 필요) — 이거 없이는 1번이
   맞아도 소용없음. 순서상 이게 실질적인 첫 구현 작업.
3. `roblox-studio-vnc` 네트워크를 실제로 만들고 `roblox-studio-docker`의
   `roblox-studio-code-docker.yml`이 위 "목표" 절의 조각을 추가하도록
   (그쪽 repo에도 반영 필요 — 그 repo의 `code-docker-integration-plan.md`에
   "Phase 2"로 이미 초안이 있음, 그대로 가져다 써도 됨).
4. 실제로 `docker compose up`까지 띄워서, code-docker(에이전트) 컨테이너 안에서는
   VNC 포트(5900)에 절대 안 닿고, host에서 code-docker-router가 forwards로 연 포트로는
   VNC가 실제로 뜨는지 (`vncviewer`든 뭐든) 끝까지 확인 — `roblox-studio-docker`
   자체 repo가 이미 `poc/code-docker-integration/`에서 비슷한 걸(네트워크 격리
   자체는) mock으로 검증해 놓은 게 있으니 그 검증 스크립트의 아이디어를 참고할 만함.
