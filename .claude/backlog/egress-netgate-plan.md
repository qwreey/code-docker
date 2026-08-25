# code-docker 아웃바운드 네트워크 제어 설계 (netgate)

작성일: 2026-08-05 — `agent-sandbox-hardening.md` 3번 항목("아웃바운드 LAN 격리")을
"호스트에서 직접 해야 함"에서 **레포 내부(순수 docker-compose)로 구현 가능한 설계**로
구체화한 문서. 아직 구현 전, 설계만 확정된 상태.

**2026-08-25 업데이트**: 이 문서가 기록하는 Phase 1 `code-docker-netinit` 사이드카
(`network_mode: service:code-docker` + NET_ADMIN, `script/netinit-entrypoint.sh`)는
**제거됐다.** 아래 "moby/moby#50326이 이론이 아니라 실제로 재현됨"이 짚었던 바로 그
컨테이너-ID 고정 문제가 2026-08-25에 실제 장애로 재발했고, 그 원인 클래스를 구조적으로
없앤 호스트측 라벨 기반 에이전트 `code-docker-netinit-docker`로 대체됐다 — 설계/장애
기록은 `.claude/backlog/netinit-docker-plan.md`, 현재 아키텍처는 루트 `CLAUDE.md`의
"docker-compose topology" 절 참고. netgate(Phase 2, squid/CIDR 차단) 자체는 이 변경과
무관하게 그대로 유지된다. 아래 본문은 원래 설계/구현 기록이라 손대지 않았다.

## 요구사항 (사용자 정의)

1. code-docker(에이전트가 임의 셸을 실행하는 컨테이너) 자신이 아웃바운드 제어를
   **스스로 바꿀 수 없어야 함** — 프롬프트 인젝션이나 에이전트의 자율적 판단으로
   방화벽/프록시 설정을 우회하는 경로가 없어야 함.
2. 사설 대역(`192.168.0.0/16` 등 RFC1918)으로 나가는 트래픽을 막고 싶음 — LAN 위
   다른 장비(공유기, NAS 등)로 에이전트가 직접 접근하는 걸 방지.
3. tailscale 관련 접근 제어는 별도(ACL) 문제라 이 설계의 범위 밖.
4. HTTP/HTTPS는 별도로 블록리스트(uBlock류 hosts 포맷) 기반 프록시를 둬서, 프롬프트
   인젝션 콘텐츠 오염에 대한 **1차/best-effort 방어**로 사용하고 싶음 — "강제적으로
   완벽히 막는다"가 목적이 아니라 실제 방어는 (2)의 네트워크 경계 + 컨테이너 권한
   최소화가 담당.
5. **호스트 시스템은 건드리지 않는다** — eBPF, 호스트 iptables 수동 설정, 호스트
   전용 에이전트 설치 등 배제. code-docker는 여러 환경에 배포되므로 `docker compose
   up`만으로 재현 가능해야 함 (Docker 엔진 자체가 관리하는 동작은 허용 — 예를 들어
   `internal: true`가 dockerd를 통해 호스트 iptables를 건드리는 것은 "Docker 기능"이지
   "호스트를 손으로 만지는 것"이 아니므로 허용).

## 검토했다가 기각한 방법

### A. 외부 컨테이너가 code-docker의 netns에 침투해 게이트웨이를 바꾸는 방식

다른(경량) 에이전트가 먼저 제안했던 방식. 컨테이너 B가 컨테이너 A의 기본 게이트웨이를
바꾸려면 A의 네트워크 네임스페이스에 들어가야 하고, 이건 `--pid=container:A` +
`CAP_SYS_ADMIN`(또는 호스트 `/proc` 마운트) 없이는 불가능하다. **기각 사유**: 이 정도
권한을 가진 B가 뚫리면 A의 netns도 사실상 같이 뚫리는 셈이라 격리 의미가 없어지고,
애초에 요구사항(호스트 안 건드림)과도 안 맞는 무거운 트릭이라 필요 이상으로 fragile함.

### B. code-docker가 스스로 기본 게이트웨이를 라우터 컨테이너로 바꾸는 방식

`ip route replace default via <router-IP>`는 기술적으로 가능하지만 **code-docker
자신에게 `NET_ADMIN`이 있어야 함**. 요구사항 (1)과 정면 충돌 — NET_ADMIN이 있으면
라우팅 조작 자체가 가능해지므로 "에이전트가 못 바꾼다"는 전제가 무너진다. 기각.

### C. Docker 브리지 드라이버로 컨테이너를 서브넷의 L3 게이트웨이로 지정

`docker network create --gateway <IP>`로 게이트웨이 주소를 지정해도, 그 주소는 항상
**호스트 커널이 들고 있는 브리지 인터페이스**에 바인딩된다. Docker 기본 브리지
드라이버에는 "이 컨테이너를 이 서브넷의 게이트웨이로 써라"라는 옵션 자체가 없다.

**단, 이건 "각 컨테이너가 자기 자신의 브리지 네트워크에 붙어 있는 상태를 유지한 채
게이트웨이만 바꾸려는" 시도에 한해서 막다른 길이라는 뜻이다.** 아래 E에서 다루듯,
애초에 code-docker를 독립된 브리지 attachment 없이 **다른 컨테이너의 네트워크
네임스페이스 자체를 공유**하게 만들면 "게이트웨이 지정"이 아니라 "그 네임스페이스
안의 라우팅 테이블을 그 네임스페이스가 만들어지는 시점에 원하는 대로 채워넣기"가
되어 이 제약을 우회하지 않고도 목표를 달성할 수 있다 — nsenter류 침투(A)나
code-docker 자신의 NET_ADMIN(B) 없이도 가능한, 뒤늦게 찾은 세 번째 경로.

### D. 호스트 방화벽(`DOCKER-USER` 체인)에서 직접 필터링

`agent-sandbox-hardening.md` 3번 항목의 원안. 효과는 확실하지만 요구사항 (5)와 충돌 —
code-docker가 배포되는 호스트마다 사용자가 수동으로 iptables 규칙을 추가해야 하고,
`docker compose up`만으로 재현되지 않는다. **완전히 배제하지는 않되(같이 쓰면 방어가
더 두꺼워짐), 레포 자체의 기본 제공 방법으로는 채택하지 않음.**

## 조사: netns 공유 + 1회성 특권 init 컨테이너 (2026-08-05 추가 조사)

논의 중 "dind처럼 netgate에도 높은 권한을 주면 안 되나"는 질문에서 출발해, 실제로
타당한 세 번째 경로(위 C 참고)를 찾아서 조사함. 아래는 그 조사 결과 — 이게 지금
채택안의 핵심 메커니즘이 됨.

**메커니즘**: Docker Compose의 `network_mode: "service:X"`는 컨테이너가 X의 네트워크
네임스페이스를 **완전히 공유**하게 한다 (별도 IP가 아니라 X의 인터페이스/IP/라우팅
테이블/루프백을 그대로 공유). capability는 네임스페이스가 아니라 프로세스(task) 단위
속성이라, 이 네임스페이스 안에서 `NET_ADMIN`을 가진 프로세스가 라우트/iptables를
설정해두면, 같은 네임스페이스를 나중에 공유하는 **capability 없는** 다른 프로세스도
그 설정의 적용은 받지만 **되돌릴 수는 없다.**

**최종안: code-docker가 계속 netns 소유주.** 처음엔 별도의 수동적 netns 홀더를 code-docker와
분리하는 안(홀더 + 1회성 init, 나중엔 홀더+init을 병합해 2컨테이너)을 검토했으나, 논의
끝에 **애초에 code-docker 자신이 자기 netns(및 대부분의 기존 `networks:`/`ports:`/
tailscale alias) 소유주 자리를 유지**하고, netinit이 거기에
`network_mode: service:code-docker`로 붙어서 라우트만 바꾸는 쪽으로 확정함
(단, `code-docker-external`/`ports: 80:80` 자체는 나중에 "정정" 절에서 다루듯 결국
손대야 함 — 여기서 "안 건드림"은 별도 홀더 컨테이너로 옮기는 리팩터를 안 한다는
뜻이지 attachment를 한 글자도 안 바꾼다는 뜻은 아님). 이유:

- **이미 동작하는 설정을 안 건드림(홀더 분리 대비).** `ports:`/`networks:`(private/
  forward alias)/tailscale 관련 설정이 code-docker에 이미 얽혀 있는데, 이걸 별도
  홀더로 옮기는 리팩터는 불필요한 리스크. code-docker의 네트워크 attachment 자체는
  거의 그대로 두고 netinit만 추가하는 쪽이 변경 범위가 훨씬 작음.
- **실패 모드가 더 일관됨.** 별도 홀더 안에서는 "홀더가 재시작되면 code-docker는 멀쩡히
  떠 있는데 그 밑에서 네트워크만 조용히 사라지는" — code-docker의 supervisord/
  code-server/ssh 세션은 계속 살아있다고 착각한 채 네트워크만 증발하는, 알아채기 어려운
  실패 모드가 생긴다. code-docker 자신이 소유주면 "네트워크가 리셋되는 사건 = code-docker
  컨테이너가 재시작되는 사건"이 항상 같이 일어나서 이해하기 쉬움 — netinit도
  `network_mode: service:code-docker`로 code-docker의 netns를 물고 있으므로 code-docker가
  죽으면 같이 죽고, code-docker가 다시 뜨면 다시 붙어서 루프가 재개됨.

### 순환 의존성 걱정 — 안 생기는 이유

이전 논의에서 걸렸던 문제는 "code-docker가 compose의 `depends_on`으로 netinit이 끝나길
기다리는" 조합(`netinit → code-docker`(network_mode 요구) + `code-docker → netinit`
(depends_on) = 2노드 순환)이었다. 해결: 그 대기를 **compose 선언이 아니라 code-docker
자신의 `entrypoint.sh` 안에서** `ip route show default`를 직접 폴링하는 걸로 처리한다.
라우트 **읽기**는 capability가 필요 없는 일반 조회라 code-docker 쪽에 아무 권한도 안
줘도 됨. compose 그래프에는 `netinit → code-docker`(network_mode가 요구하는 "code-docker
먼저 떠야 함") 방향 엣지 하나만 남고 반대 방향은 없어서 사이클이 안 생긴다.

### 최종 구조 (2컨테이너)

1. `code-docker` — tailscale alias는 그대로 보유하되 `code-docker-external: {}`는
   제거하고 `ports: - "80:80"`은 netgate로 이전(아래 "정정"/"인바운드" 절 참고 — 이
   시점엔 아직 그 결론 전이라 "변경 없음"으로 적혀 있었음, 최종 결론은 정정 절이 맞음).
   `entrypoint.sh` 맨 앞에 `ip route show default`가 나올 때까지 폴링하는 가드 추가 —
   netinit이 라우트를 심을 때까지 이후 로직(예: `user-init.sh`의 qwreey-fish curl)이
   시작되지 않게 함.
2. `code-docker-netinit` — `network_mode: service:code-docker` + `cap_add: [NET_ADMIN]`
   + `depends_on: {code-docker: {condition: service_started}}`. 시작하자마자, 그리고
   이후 방어적 루프(모든 명령 실패를 무시하고 절대 non-zero exit으로 끝나지 않음)로
   계속:
   ```sh
   while true; do
     ip route replace default via "$(getent hosts netgate | awk '{print $1}')" 2>/dev/null
     sleep 5
   done
   ```

### 재시작 복원력

- code-docker가 재시작되면: netns가 통째로 새로 만들어지고 라우트가 사라진 채로
  시작하지만, entrypoint의 폴링 가드가 netinit의 다음 루프 주기(최대 5초)를 기다렸다가
  진행함 — **인터페이스가 "깨진 채로 돌아오는" 게 아니라 완전히 새로 만들어지는 것**이라
  스크립트 입장에서 이상 상태를 다룰 필요가 없음(멱등 `ip route replace`만 반복하면 됨).
- **좀비 방지 방안 결정됨**: netinit은 `ip` 명령을 직접 쓰므로 자기 인터페이스가
  사라졌는지도 스스로 감지할 수 있다 — 감지 시 non-zero exit으로 컨테이너 자체를
  종료시켜 `restart: unless-stopped`가 재시작하게 하거나, 그냥 내부 루프 안에서 계속
  재시도해도 됨(둘 다 허용, 구현 시 편한 쪽으로). `depends_on: {code-docker: {condition:
  service_started}}`가 있는 한 code-docker가 안 살아나면 netinit도 안 살아나는 게
  맞는 동작(의도된 fail-closed) — 이건 버그가 아니라 의도.
- **검증은 여전히 필요**: 위 방안이 실제로 좀비 상태 없이 깔끔하게 동작하는지는
  구현 후 `docker stop code-docker` → 상태 확인 → `docker start code-docker` →
  netinit이 자동으로 재부착/재개되는지 직접 테스트해서 확인. moby #50326이 이 언저리의
  edge case가 실제로 존재함을 보여주는 사례이므로 낙관하지 말 것.

**실사용 선례 확인함**: Kubernetes/Istio의 `istio-init` 컨테이너가 정확히 이 패턴
(파드의 공유 netns에 `NET_ADMIN`/`NET_RAW`로 iptables 리다이렉트 규칙을 심고 종료,
이후 뜨는 앱/사이드카는 Istio 1.10+ 기준 무권한)이고, Docker Compose 규모에서도
Tailscale 사이드카를 이 패턴(netns 소유 컨테이너 + `NET_ADMIN` 사이드카 + 무권한
앱 컨테이너)으로 구성한 실사용 사례를 확인함 — "이 권한은 컨테이너의 네트워크
네임스페이스 안에만 머물러 호스트 네트워크는 못 건드린다"는 동일한 결론.
(Istio가 이후 `istio-cni`로 옮겨간 건 "워크로드마다 NET_ADMIN을 부여할 Kubernetes
RBAC 권한 자체가 멀티테넌시 관리 부담"이라는 K8s 특유의 문제 때문 — 단일 운영자가
compose 파일을 직접 쓰는 이 레포에는 해당 안 됨.)

**기존 구현체 조사 (netinit/netgate를 처음부터 새로 짤지 확인)**:
- [qdm12/gluetun](https://hub.docker.com/r/qmcgaw/gluetun) — VPN 클라이언트가 주
  목적이지만, 딸린 방화벽(킬스위치) 컴포넌트가 정확히 이 설계와 같은 메커니즘을 씀:
  `NET_ADMIN`을 가진 gluetun 컨테이너에 다른 컨테이너들이
  `network_mode: "service:gluetun"`로 붙고, gluetun이 iptables로 그 컨테이너들의
  아웃바운드를 통제(`FIREWALL_OUTBOUND_SUBNETS`로 LAN 등 특정 대역 예외 허용 — 이
  설계의 RFC1918 CIDR 룰과 목적이 같음). **다만 VPN 연결 자체가 핵심 기능이라 방화벽만
  떼어 쓰기엔 무겁고 이 레포의 "필요한 것만 작게 만든다" 기조와 안 맞아서, 통째로
  가져다 쓰진 않음** — 대신 이 메커니즘이 실제로 검증된 프로덕션급 패턴이라는 근거,
  그리고 정확히 우리가 우려했던 것과 같은 종류의 알려진 한계(gluetun 이슈 트래커에
  "iptables 규칙이 Docker 네트워크 초기화 이후에 적용되어 그 사이 ~15ms 정도 트래픽이
  방화벽 없이 나갈 수 있는 창이 있다"는 게 문서화돼 있음)로 참고함 — 이 설계도 완벽한
  무결점을 주장하지 않고 "충분히 작은 창, 알려진 한계"로 다루는 게 맞다는 근거가 됨.
- [jpetazzo/squid-in-a-can](https://github.com/jpetazzo/squid-in-a-can) — 전 Docker
  직원 Jérôme Petazzoni의 최소 squid 컨테이너 예제. netgate의 squid 스테이지를 처음부터
  다 짜지 않고 이런 최소 예제를 베이스로 가져다 다듬는 쪽이 합리적.
- [Pugemon/docker-proxy-sidecar](https://github.com/Pugemon/docker-proxy-sidecar) —
  redsocks 기반, `http_proxy`를 지원 안 하는 앱까지 투명하게 프록시로 리다이렉트하는
  사이드카. 이번 설계는 라우팅 레벨(1단계)에서 이미 투명성을 확보해서 당장 필요하진
  않지만, squid TPROXY 설정이 막히는 경우의 대안으로 참고 가치 있음.

**공격 표면 평가**: 공유되는 건 네트워크 계층뿐 — 프로세스/파일시스템 격리는
그대로 유지됨(일반 조사 결과 및 Tailscale 사이드카 사례 둘 다 동일). netinit이 아무
서비스도 안 띄우므로 code-docker가 새로 들여다볼 수 있는 것도 없음. 지켜야 할 설계
규칙: **netinit은 code-docker가 쓸 수 있는 볼륨/파일에서 설정을 읽으면 안 됨**
(순서 보장상 문제는 없지만 경계를 굳이 흐릴 이유가 없음 — 설정은 이미지에 굽거나
compose 환경변수로만).

**알려진 함정 (보안 아님, 운영/가용성)**: moby(Docker 엔진) 이슈
[#50326](https://github.com/moby/moby/issues/50326) — netns 소유 컨테이너가
재시작/중단되면 그 netns를 참조하던 컨테이너들이 "cannot join network namespace of
a non running container"로 자동 기동 실패하고 수동 개입이 필요할 수 있음. 이 설계에서는
netns 소유주가 code-docker 자신이라, code-docker가 재시작되는 도중에 netinit이 하필
그 타이밍에 재시작을 시도하면 걸릴 수 있음 — `restart: unless-stopped`로 창을 최대한
줄이는 것 외엔 근본 해결책 없음.

## 채택한 아키텍처 (2단 구조)

**1단계 — 투명 L3 라우팅 (netns 공유, 위 조사 결과 채택)**: code-docker는 지금처럼
자기 자신의 네트워크(`code-docker-internal`)를 소유하되, `code-docker-netinit`이 거기
안으로 `network_mode: service:code-docker`로 들어와 기본 게이트웨이를 netgate로 계속
재적용함. 기본 게이트웨이가 이렇게 고정되어 있어 **애플리케이션이 프록시 설정을 하지
않아도** 모든 아웃바운드가 netgate를 거침. code-docker 자신에게는 NET_ADMIN을 주지 않음
(netinit에만 있음).

**2단계 — netgate의 필터링**: `code-docker-internal` + `code-docker-external` 양쪽에
다리를 걸친 netgate가:
- 자기 netns 안에서(dind와 동일하게 "자기 자신에게만 국한된" 권한) `ip_forward=1` +
  `iptables -t nat POSTROUTING MASQUERADE` + `FORWARD` 체인에 RFC1918 등 CIDR DROP.
  **`code-docker-internal` 자기 대역에 대한 예외 처리는 불필요** — longest prefix
  match 원리상 code-docker↔dind, code-docker↔netgate 같은 같은 서브넷 내 통신은
  connected route로 처리돼 애초에 netgate를 거치지 않으므로, RFC1918을 통째로 막아도
  같은 브리지에 붙은 컨테이너끼리는 영향이 없다(2026-08-05 확인, 구현 시
  `docker network inspect code-docker-internal`로 실제 CIDR만 재확인).
- HTTP(S)는 squid를 TPROXY 모드로 얹어 `CONNECT host:port`의 호스트명 기준
  블록리스트(uBlock류 hosts 포맷 변환) 필터링 — 순수 IP 라우팅만으로는 도메인을 못
  보므로 이 계층이 콘텐츠 오염 방어(요구사항 4)를 담당.

### 정정: `code-docker-external`는 code-docker에서 실제로 떼어내야 함 (2026-08-05)

앞서 "code-docker의 `networks:`/`ports:` 그대로 유지"라고 정리했을 때, "별도 netns 홀더로
옮기지 않는다"는 것과 "`code-docker-external` attachment를 그대로 둔다"를 혼동한 채로
넘어갔다 — 후자는 틀렸다. code-docker가 지금처럼 `code-docker-external: {}`에도 직접
붙어 있으면, netinit이 기본 라우트를 netgate로 아무리 잘 심어도 code-docker 자신이
가진 **또 다른 인터페이스**(code-docker-external 쪽)로 직접 나가는 길이 여전히 존재한다
— "netgate를 거치지 않고는 나갈 방법이 없다"는 핵심 요구사항이 깨진다. **결정: `docker-
compose.yml`에서 `code-docker` 서비스의 `networks:`에서 `code-docker-external: {}`
항목을 제거한다.** `ports:`/tailscale `private`/`forward` alias는 그대로 둔다(이건
`code-docker-internal`/`code-docker-forwards`에 걸려 있어 문제 없음) — 단, `ports:
- 80:80`은 아래 "인바운드" 절 이유로 어차피 netgate로 옮겨야 한다.

### 인바운드: netgate가 포트포워딩도 담당 (2026-08-05 확인)

`docker compose` 공식 문서: "`internal: true`를 설정한 네트워크는 호스트의 네트워크
인터페이스와 연결되지 않은 채로 만들어진다." 이 말대로라면, code-docker가
`code-docker-internal`에만 붙어 있는 상태에서 `ports: - 80:80`을 그대로 둬도 호스트에
퍼블리시가 안 될 가능성이 높다 — 외부 Caddy가 code-docker에 도달할 방법이 없어짐.
(공식 문서가 "외부 연결이 없다"고만 말하고 포트 퍼블리시 자체를 명시적으로 다루진
않아 100% 확정은 아니지만, 아래 결정은 이 불확실성과 무관하게 옳은 선택이다.)

**결정: `ports: - 80:80`을 code-docker가 아니라 netgate 서비스로 옮긴다.** netgate는
이미 `code-docker-external`(호스트/인터넷 쪽)에 붙어 있으므로 포트 퍼블리시가 정상
동작하고, 자기 netns 안에서 인바운드 DNAT로 code-docker의 실제 IP로 넘겨준다:
```sh
iptables -t nat -A PREROUTING -p tcp --dport 80 -j DNAT --to-destination code-docker:80
iptables -A FORWARD -d code-docker -p tcp --dport 80 -j ACCEPT
```
집에서 쓰는 공유기의 "포트포워딩"과 완전히 같은 개념 — netgate가 아웃바운드 필터링과
인바운드 포트포워딩을 둘 다 담당하는 유일한 국경 통과 지점이 되어, 이 레포에서 이미
쓰고 있는 "국경을 넘는 컨테이너는 신뢰 수준이 다르다"는 원칙(dind와 동일)과도 일치한다.
이 DNAT용 FORWARD ACCEPT 룰은 RFC1918 DROP 룰보다 **먼저**(iptables 체인 순서상 위에)
와야 한다 — code-docker의 IP 자체가 RFC1918 대역에 속하므로, 순서를 잘못 두면 이
포트포워딩 자체가 막혀버린다 (아래 "순서 있는 allow/block 레이어" 참고).

### 포트포워딩 일반화 + 설정 기반 구성 (2026-08-05 확정)

netgate가 하는 일을 다시 보면 정확히 "가정용 공유기의 포트포워딩"과 같은 개념이다 —
그리고 이건 code-docker:80 하나에 하드코딩할 이유가 없다. **netgate는 `code-docker-
internal`에 붙은 임의의 컨테이너:포트로 포워딩해줄 수 있는 범용 라우터로 설계**하고,
사용자가 iptables를 직접 위험하게 건드리는 대신 **yml/json 설정 파일**로 원하는
포워딩(및 아웃바운드 CIDR allow/block 룰)을 선언하면 netgate가 시작 시점에 그걸 읽어
iptables 룰로 변환하는 구조로 간다. 이 레포에 이미 정확히 같은 모양의 선례가 있음 —
`config/tailscale-config.default.yaml`의 `forwards:`/`publish:` 리스트(사용자가 포트
목록을 선언하면 스크립트가 그걸 읽어 실제 배관을 구성)와 같은 override 패턴을
따르면 됨(`config/netgate/config.default.yaml` 형태로).

### 부가 이점: nginx보다 앞단에서, HTTP 말고도 인바운드 소스 IP 제어 가능

netgate가 인바운드 DNAT를 담당하게 되면서 얻는 부수 효과 — nginx(`NGINX_BLOCK_
LOOPBACK`, `TRUSTED_PROXIES`, `ALLOWED_HOSTS`)보다 **더 앞단, 더 낮은 레이어**에서
소스 IP 기준 필터링이 가능해진다. 그리고 이건 nginx가 다루는 HTTP(포트 80)에 국한되지
않고, netgate가 포워딩하는 **모든 포트/프로토콜**(예: sshd 22번)에 똑같이 적용 가능 —
각 서비스(nginx, sshd)가 각자 자기 레벨에서 IP 제어를 구현할 필요 없이, netgate
설정 하나로 "이 포워딩은 어떤 소스에서 오는 연결만 받는다"를 선언적으로 통제할 수
있음. nginx의 기존 제어들을 대체하는 게 아니라 **한 겹 더 앞에 추가되는 방어선**으로
문서화할 것.

### 위험 패턴 경고: 국경을 걸치는 새 컨테이너를 즉흥적으로 추가하지 말 것

`code-docker-internal`과 `code-docker-external`(또는 호스트) 양쪽에 붙는 컨테이너는
그 자체로 netgate/dind와 동급의 신뢰 레벨을 가진다. "Caddy가 code-docker에 못
닿으니 중간에 프록시 컨테이너 하나 두자"는 식으로 `(외부 Caddy) → (새 브리징
컨테이너) → code-docker` 패턴을 즉흥적으로 추가하면, netgate가 막아둔 아웃바운드
필터링을 완전히 우회하는 새 구멍(그 브리징 컨테이너를 통해 나가는 길)이 생길 수 있다.
**이런 요구가 생기면 netgate 자체를 확장하거나 기존 nginx/dev-proxy 메커니즘을 쓸
것 — 새 브리징 컨테이너를 추가하지 말 것.** 사용자 문서에 명시적으로 경고할 것.

### 우리가 못 막는 것 (문서화 전용, 기술적 해결 불가)

두 가지 서로 다른 "이 시스템으로 못 막는 구멍"이 있고, 성격이 다르므로 구분해서
문서화해야 한다:

1. **사용자가 직접 새 경로를 여는 경우** — `code-docker-external`을 code-docker에
   다시 붙이거나, 위의 브리징 컨테이너 패턴 추가 등. netinit이 부분적으로 도울 수
   있음 — 이미 `NET_ADMIN`으로 라우팅을 보고 있으니, 루프 안에서 "예상한 netgate 외의
   다른 게이트웨이/인터페이스가 있는지"도 같이 점검해서 있으면 경고 로그를 남기는 걸
   추가 가능(정책적으로 되돌리기까지 할지는 별도 결정 — 사용자의 의도적 변경을
   되돌리는 거라 신중해야 함, 기본은 감지+로그만).
2. **정상적으로 허용된 아웃바운드 연결이 그 자체로 우회 통로가 되는 경우** —
   블록리스트에 없는 정상 도메인(예: 어떤 SaaS API)에 code-docker가 요청을 보냈는데,
   그 서비스가 요청 파라미터에 따라 다른 목적지로 릴레이/fetch 해주는 기능이 있다면,
   그 요청 자체는 netgate 입장에서 완전히 정상 트래픽이라 막을 방법이 없다. 이건
   code-docker 경계를 벗어난 원격 서버에서 일어나는 confused-deputy 패턴이라 **네트워크
   레이어의 어떤 통제로도 원천적으로 해결 불가능** — 사용자 문서에 명확한 한계로
   명시하고 경고하는 것 외엔 방법이 없음.

### 순서 있는 allow/block 레이어 (2026-08-05 확정)

netgate의 CIDR 설정은 **평평한 차단 목록이 아니라 순서를 보존하는 규칙 리스트**로
설계한다 — iptables 체인이 원래 first-match-wins(첫 매치에서 멈춤)로 동작하므로,
"넓은 대역 차단 + 그 안의 특정 IP만 예외 허용" 같은 걸 CIDR을 수동으로 쪼개 계산할
필요 없이 순서만 맞추면 표현된다:
- 구체적인 예외(허용)를 **먼저**, 넓은 차단을 **나중**에 배치 — 예:
  `192.168.0.8/32 ACCEPT` 룰이 `192.168.0.0/16 DROP` 룰보다 위에 있어야
  `.8`만 예외로 통과함(반대로 두면 `.8`도 넓은 차단에 먼저 걸려서 예외가 무의미해짐).
  위 인바운드 DNAT용 ACCEPT 룰도 이 순서 원칙을 따라야 함.
- 반대로 전체를 화이트리스트 모드로 뒤집고 싶으면 "구체적 허용들을 위에, 맨 아래
  `0.0.0.0/0 DROP` catch-all"로 구성 — 이것도 같은 순서 원칙의 자연스러운 응용.
- 이 설계는 WireGuard의 `AllowedIPs`(플랫 라우팅 테이블이라 겹치는 CIDR을 수동으로
  분해해야 하는 문제 — 예: 국내망만 추리려면 계산량이 폭발) 대비 확실한 장점이라
  선택. netgate 설정 파일 포맷은 (action, CIDR) 순서쌍의 리스트로 만들고, 이를 그
  순서 그대로 `iptables -A FORWARD <action> -d <cidr>`로 변환하는 스크립트면 충분.

### 액티브 방어 vs 패시브 방어 (성격이 다름 — 2026-08-05 논의로 명확화)

- **액티브 방어 = netgate의 CIDR 차단 + netinit의 라우팅 통제.** 목적은 "컨테이너 안의
  (오염된) 에이전트가 밖으로 공격을 시도하는 것"을 막는 것 — 예: `192.168.0.1` 같은
  치명적일 수 있는 사설 IP로 직접 뻗는 것. code-docker가 절대 우회할 수 없어야 하므로
  이 부분은 요구사항 (1)대로 강제적이어야 함.
- **패시브 방어 = 콘텐츠 블록리스트(및 아래 향후 확장의 DNS 차단).** 목적은 "밖에서
  들어오는 공격적인/오염된 콘텐츠가 들어오는 걸 약간 막는 것" — 프롬프트 인젝션
  콘텐츠 오염에 대한 1차 방어. 이건 **애초에 완벽할 수 없음이 목적에 포함된 개념**:
  내부자(오염된 에이전트)가 작정하고 우회하려면(IP 직접 지정, 리스트에 없는 새 도메인
  등) 얼마든지 우회 가능 — 그래서 강제적일 필요가 없고, "나쁜 것 좀 덜 들어오게" 정도의
  기대 수준이면 충분함(요구사항 4의 원래 의도와 일치).
- 따라서 CIDR/도메인 리스트는 **둘 다 blocklist(기본 허용, 나쁜 것만 차단) 방향으로
  통일** — 콘텐츠는 애초에 allowlist로 관리하기엔 대상이 너무 많아 브라우저 uBlock류와
  동일하게 blocklist가 자연스럽고, CIDR도 blocklist로 구현해두면 원하는 사용자는 그냥
  룰을 뒤집어 whitelist처럼 쓸 수 있어(구현 비용 차이가 크지 않다면) 굳이 두 가지 모드를
  다 만들 필요는 없음 — **결정: blocklist 하나만 구현**.
- 콘텐츠 블록리스트 소스는 프롬프트 인젝션 특화 리스트를 따로 찾을 필요 없이 **표준
  범용 리스트(예: StevenBlack/hosts)로 충분** — 목적이 완벽 차단이 아니라 1차
  필터링이므로.

### 향후 확장 (이번 라운드 범위 밖, 필요성 확인되면 나중에)

- **DNS 리졸버 제어** — code-docker의 compose `dns:` 필드를 netgate의 IP로 지정하고
  netgate가 dnsmasq/unbound 등으로 도메인 해석 단계부터 블록리스트를 적용하면, 프록시를
  안 쓰는 도구(raw TCP 등)에도 차단 효과가 미쳐서 콘텐츠 블록리스트보다 한 단계 더
  강한 패시브 방어가 됨. 다만 이것도 여전히 패시브임 — 앱이 자체적으로 `1.1.1.1`
  같은 다른 네임서버를 쓰거나(DoH 포함), IP를 직접 지정하면 그대로 뚫림. 지금은
  필요성이 확인되지 않아 범위 밖으로 두고, 나중에 켜고 싶어지면 추가. (참고: Docker
  내장 DNS(`127.0.0.11`)는 dockerd가 라우팅 경로를 안 타고 직접 가로채 처리하는 특수
  경로라, 라우트만 바꿔서는 DNS 트래픽까지 netgate를 거치게 할 수 없음 — `dns:` 필드로
  명시적으로 지정해야 함.)

```
                          ┌─ 아웃바운드 ─────────────────────────┐
code-docker (code-docker-internal 전용, code-docker-external 제거, NET_ADMIN 없음)
   │  (code-docker-netinit이 지속적으로 심어주는 라우트로 인해 자동으로)
   │  default gw = netgate
   ▼
code-docker-netgate (code-docker-internal + code-docker-external 양쪽, 자기 netns
   │  안에서만 NAT/iptables 권한)
   │  - ip_forward + MASQUERADE + FORWARD 순서 있는 allow/block 룰(RFC1918 등, 투명)
   │  - squid TPROXY (dstdomain 블록리스트, HTTP(S) CONNECT 호스트명 기준)
   ▼
code-docker-external → 인터넷
                          └───────────────────────────────────────┘

                          ┌─ 인바운드 ──────────────────────────┐
호스트:80 (ports: - "80:80"는 이제 netgate 서비스에 선언)
   ▼
code-docker-netgate — PREROUTING DNAT --to-destination code-docker:80
   ▼
code-docker:80 (nginx, code-server/webmanager)
                          └───────────────────────────────────────┘

code-docker-netinit (network_mode: service:code-docker + NET_ADMIN + 방어적 루프로
   code-docker의 netns 안에 기본 라우트를 지속적으로 재적용, restart: unless-stopped)
```

### 왜 이게 요구사항을 만족하는가

- code-docker는 NET_ADMIN이 없고, 심어진 라우트를 되돌릴 방법이 없음 — 프록시 설정을
  지우거나 우회를 시도해도 물리적으로 netgate를 거치지 않고는 나갈 방법이 없음
  (우회가 아니라 fail-closed).
- RFC1918 등 사설 대역 차단과 블록리스트 필터링 룰은 전부 netgate 컨테이너 안에만
  존재하고 code-docker는 접근/쓰기 권한이 없음 (`dind-authz`의 `/etc/dind-authz.d`가
  code-docker에 마운트 안 되는 것과 동일한 원칙 — CLAUDE.md dind 절 참고).
- HTTP(S) 블록리스트는 squid가 `CONNECT host:port`의 호스트명만 보고 판단 — TLS를
  까지(MITM) 않아도 도메인 단위 차단이 가능하므로, "강제적이지 않은 1차 방어"
  요구사항에 맞으면서 인증서 발급/신뢰 스토어 관리 복잡도를 피할 수 있음.
- 전부 `docker-compose.yml`/`Dockerfile`/`config/`에 표현되므로 호스트를 손으로
  만질 필요 없음 — `network_mode: service:X`도, netgate 자기 netns 안의 iptables도
  전부 Docker가 만든 컨테이너 netns들 사이의 일이라 호스트 자체의 netns/iptables는
  전혀 안 건드림 (`network_mode: host` 기반 TPROXY안과는 질적으로 다름 — 그건 여전히
  기각 상태).

### 솔직한 한계 (구현 전에 인지해야 할 것)

- **moby #50326 함정** (위 조사 결과) — code-docker가 재시작되는 도중에 netinit이 하필
  그 타이밍에 (재)붙기를 시도하면 실패하고 수동 개입이 필요할 수 있음. `restart:
  unless-stopped`로 창을 최대한 줄이는 것 외엔 근본 해결책 없음. 구현 후 실제로
  `docker stop/start code-docker`를 반복 테스트해서 자동 복구되는지 검증 필요(위
  "재시작 복원력" 참고). 운영 절차(예: 재부팅 후 확인 체크리스트)에도 반영 필요.
- **compose 구조가 2개 서비스로 늘어남** (`code-docker`, `code-docker-netinit`) —
  code-docker 자신의 tailscale `private`/`forward` alias는 그대로 두지만,
  `code-docker-external: {}`는 제거하고 `ports: - 80:80`은 netgate로 이전해야 함
  (위 "정정: code-docker-external는..." / "인바운드" 참고) — 처음 생각했던 것보다
  code-docker 쪽 compose 변경 범위가 조금 더 있음. netinit은 완전히 새로운 서비스
  추가 + code-docker `entrypoint.sh`에 폴링 가드 추가.
- **HTTPS 본문 콘텐츠까지 블록리스트로 거르려면** TLS MITM(자체 CA 주입)이 필요한데,
  요구사항 (4)가 "강제적이지 않은 1차 방어" 수준이라 기본 설계에서는 제외. 필요해지면
  별도 확장 항목으로.
- **`code-docker-dind`도 이번 범위에 포함 — 결정됨(2026-08-05 재확인).** 내부 에이전트가
  오염되면 dind 경유로 별도 프록시/터널을 만들어 우회할 수 있으므로(액티브 방어 관점에서
  code-docker와 동일하게 다뤄야 함), dind의 아웃바운드도 막는 걸로 확정. **dind도
  `docker-compose.yml`에서 `code-docker-external: {}`를 제거**하고(code-docker와
  동일한 이유 — 그대로 두면 netgate를 거치지 않는 직행 경로가 남음), `docker pull` 등을
  위한 인터넷 접근은 code-docker와 마찬가지로 netgate 경유로 통일. 구현은 code-docker
  보다 쉬움 — **dind는 이미 `privileged: true`라 별도 netinit 사이드카가 필요 없고, 자기
  `script/dind-entrypoint.sh`에 같은 방어적 라우팅 루프를 직접 추가하면 됨**(이미 다른
  컨테이너의 netns를 빌릴 필요 없이 자기 권한으로 자기 자신을 설정). netgate가
  재시작되면 `getent hosts netgate`가 새 IP를 다시 알려주므로(Docker 데몬이 호스트
  이름 해석을 계속 관리) 루프가 알아서 재적용함 — netns 전체가 사라지는 게 아니라
  피어(netgate)가 잠깐 없어졌다 돌아오는 것뿐이라 code-docker 쪽보다 오히려 간단함.
  **구현 시 주의**: `dind-entrypoint.sh`는 마지막에 `exec dockerd`로 이어지는데, 이
  루프를 백그라운드(`&`)로 띄우고 넘어가야 함 — dockerd가 이후 PID 1이 되면서 좀비
  프로세스 reap을 안 해줄 수 있으니(`ip`/`getent`를 5초마다 fork하는 루프라 누적 가능),
  tini 같은 초경량 init을 앞단에 두거나 루프 스크립트 자체가 자식을 안 남기게(`wait`
  처리 등) 신경 써야 함.
- netgate(및 netinit)가 뚫리면(설정 실수, 취약점) 그 자체가 우회 지점이 됨 — 이
  컨테이너들은 code-docker보다 신뢰 수준이 높아야 하므로 최소 권한(꼭 필요한 cap만,
  예: `SYS_MODULE` 같은 건 절대 추가하지 않음 — Tailscale 사이드카 사례에서도 명시적
  경고됨)으로 구성해야 함. dind-authz의 "네가 상대적으로 더 신뢰된 컨테이너다"라는
  포지션과 동일.
- **구현 순서 결정됨: netinit(1단계) 먼저, netgate(2단계) 나중.** 기술적으로는 어느
  순서로 만들어도 상관없지만(플레이스홀더 게이트웨이로 netinit 먼저 만들고 netgate를
  나중에 붙여도 되고, 반대도 가능), 테스트 관점에서 netinit을 먼저 만들면 "code-docker의
  아웃바운드가 실제로 끊기는지"(존재하지 않는 게이트웨이로 라우트를 잡아도 인터넷이
  죽는지)를 바로 눈으로 확인할 수 있어 검증이 쉬움. netgate는 그 위에 실제 필터링
  로직을 얹는 두 번째 단계로.

## Phase 1 구현 완료 (2026-08-05)

netinit + 라우팅 강제(이 문서의 "1단계")까지 구현/검증 완료. netgate 자체(2단계 -
squid, CIDR 차단, 인바운드 DNAT)는 아직 미착수 - 다음 작업 세션의 범위.

**실측 검증 결과** (격리된 워크트리에서, `PREFIX=egtest-`로 실제 운영 중인
인스턴스와 완전히 분리해서 진행 - `alpine: sleep infinity` 임시 스텁을 `netgate`
alias로 붙여 검증 후 제거함):
- `docker exec code-docker ip route show` → `default via <스텁 IP> dev eth0` +
  connected route 두 개만 존재 확인.
- `docker exec code-docker curl -m 3 https://1.1.1.1` → 3초 타임아웃으로 실패 확인
  (진짜 인터넷 접근 완전 차단).
- `docker exec code-docker ping <스텁 IP>`, `ping dind` → 둘 다 정상 응답 (같은
  서브넷 connected route는 netgate를 거치지 않고 그대로 열려있음, 설계대로).
- dind도 동일 - `default via <스텁 IP>`, 실제 인터넷 `wget`은 "Network
  unreachable"로 실패, 스텁으로의 ping은 정상.
- entrypoint.sh의 라우트 대기 가드도 실측 확인: netinit이 라우트를 심을 때까지
  정확히 대기했다가 통과 (`entrypoint: waiting for netinit...` →
  `entrypoint: default route present, continuing`).

**moby/moby#50326이 이론이 아니라 실제로 재현됨** - `docker restart code-docker`로
code-docker만 재시작했더니 code-docker의 네트워크 네임스페이스가 새로 만들어졌고
(inode 번호가 바뀜, `/proc/1/ns/net` 확인), 그 시점에 이미 붙어있던
code-docker-netinit은 옛 네임스페이스에 고아로 남아 `lo`만 보이는 상태가 되어
라우트를 전혀 못 심었다 (재시도로도 해결 안 됨 - 죽은 네임스페이스 안에서는
`ip route replace`가 무의미). **대응: 이 문서의 "좀비 방지 방안 결정됨"/"구현 시
필요한 작업 목록"에서 "허용된 두 옵션 중 하나"로만 언급했던 "감지 시 non-zero
exit"을 실제로 구현함** - `script/netinit-entrypoint.sh`가 루프 시작마다
`ip -o link show`로 loopback 외 인터페이스가 하나도 없는지 확인하고, 없으면
(옛 netns에 고립된 것으로 판단) exit 1 → `restart: unless-stopped`가 컨테이너를
재생성 → 현재 code-docker가 소유한 새 netns에 다시 합류. `docker restart
code-docker` 직후 15초 안에 netinit이 스스로 재기동해 라우트를 정상적으로
재적용하는 것까지 실측 확인함. 이 문서의 "재시작 복원력" 절이 "검증 필요"라고
남겨뒀던 부분이 이걸로 해소됨 - 이론적으로 가능한 두 옵션(exit+restart vs 내부
루프 재시도) 중 실제로는 **exit+restart만 유효함**(내부 루프 재시도는 죽은
네임스페이스에서 근본적으로 무의미하므로) - 그냥 "구현 시 편한 쪽" 문제가 아니라
실측으로 좁혀진 결론이었다.

**옵트아웃 메커니즘 - `profiles:`가 아니라 `NETGATE_ENABLED` 환경변수로 결정.**
"결정됨" 6번이 "가능하면 compose `profiles:`를 우선 검토"라고 남겨뒀던 부분의
최종 결론. Compose profiles는 태생적으로 opt-in이다 - 프로필이 붙은 서비스는
`COMPOSE_PROFILES`/`--profile`로 명시적으로 활성화해야만 뜬다. 반대로 "기본
켜짐 + 옵트아웃"을 표현하려면 `.env`에 `COMPOSE_PROFILES=netgate`를 기본값으로
박아둬야 하는데, 이 레포는 CLAUDE.md/example-env가 명시하듯 "`.env` 파일이 아예
없어도 정상 동작"이 원칙이라 이 트릭이 성립하지 않는다 (`.env`가 없으면
`COMPOSE_PROFILES`도 없고, 곧 프로필 비활성 → 기본 꺼짐이 되어버림 - 요구사항과
정반대). 그래서 기존 `TAILSCALE_ENABLED` 패턴(서비스는 항상 뜨되, 엔트리포인트가
런타임에 env var를 보고 idle로 빠지는 방식)을 그대로 따라 `NETGATE_ENABLED`(기본
`true`)를 도입함 - `code-docker-netinit`/dind 루프, `entrypoint.sh`의 라우트
대기 가드가 이 값을 봄. **단, 이건 "동작"만 끄는 옵트아웃이지 `networks:`의
`code-docker-external` 제거 자체를 되돌리지는 못한다** - Compose는 네트워크
attachment를 런타임 env var로 조건부 처리할 수 없기 때문 (`${VAR}` 보간은 스칼라
값에만 적용되지, 맵 키의 존재 여부 자체를 결정하지 못함). 완전한 토폴로지 롤백은
`docker-compose.yml`을 직접 편집(`DIND_TARGET=dind`로 dind-authz를 완전히 끄는 것과
같은 성격의, 의도적으로 눈에 띄는 수동 작업)해야 한다 - `docs/egress-netgate.md`와
`example-env`에 정확한 절차를 문서화함.

**구현하면서 확인/정정한 것들**:
- `config/build.default.sh`에 `iproute2`를 명시적으로 추가 - code-docker
  자신(entrypoint.sh의 라우트 대기 가드)이 `ip route show default`를 쓰려면 필요.
  전이 종속성에 우연히 딸려오는 걸 기대하지 않고 명시함.
- dind의 새 방어 루프는 `script/dind-entrypoint.sh` 마지막 `exec` 직전에 백그라운드로
  추가하고, 최종 `exec`를 `tini --`로 감쌌음 (Alpine `apk add iproute2 tini`) -
  dockerd가 PID 1이 된 뒤에도 좀비 없이 정상 동작 확인 (`ps aux`로 `tini`가 PID 1,
  `dockerd`/`containerd`/`dind-authz`/루프의 `sleep 5`가 모두 정상적으로 자식으로
  붙어있는 것 확인).
- `code-docker`의 `ports: - 80:80`은 완전히 주석 처리(빈 `ports: []`가 아니라 키
  자체를 주석 처리 - `docker compose config`가 빈 배열 `ports:`를 거부함을 실측
  확인).

## 구현 시 필요한 작업 목록

### Phase 1 (netinit + 라우팅 강제) — 완료 (2026-08-05)

- [x] `script/netinit-entrypoint.sh` — `getent hosts netgate`로 IP 알아내 `ip route
  replace default via ...`를 5초 간격으로 반복. `ip`/`getent` 실패는 무시하고 절대
  non-zero exit으로 끝나지 않지만, **자기 netns가 고아가 된 경우(loopback만 남은
  경우)는 예외적으로 exit 1** — 위 "Phase 1 구현 완료" 절 참고, 이건 계획에 없던
  추가 조사 결과. 매 루프마다 "예상한 netgate 외의 다른 기본 게이트웨이/인터페이스가
  있는지"도 점검해서 있으면 경고 로그.
- [x] `entrypoint.sh` 맨 앞에 `ip route show default` 폴링 가드 추가 (60초 타임아웃,
  타임아웃 시 명확한 에러 로그 + exit 1) — netinit이 라우트를 심을 때까지 이후
  네트워크 관련 로직(user-init.sh의 qwreey-fish curl 포함) 대기.
- [x] `Dockerfile`에 `netinit` 스테이지 추가 (alpine + iproute2).
- [x] `docker-compose.yml`: `code-docker-netinit` 서비스 추가
  (`network_mode: service:code-docker` + `cap_add: [NET_ADMIN]` +
  `depends_on: {code-docker: {condition: service_started}}`). `code-docker`와
  `code-docker-dind` 둘 다에서 `code-docker-external: {}` 제거. `code-docker`의
  `ports: - "80:80"`은 완전히 주석 처리(`TODO(netgate phase 2)` 표시, netgate로
  이전은 Phase 2에서). code-docker의 tailscale `private`/`forward` alias는 그대로 둠.
- [x] `script/dind-entrypoint.sh`에 netinit과 동일한 방어적 라우팅 루프 추가 (백그라운드
  + `tini --`로 최종 `exec` 감싸서 좀비 방지 — 실측으로 정상 동작 확인).
- [x] 옵트아웃: `profiles:` 대신 `NETGATE_ENABLED` 환경변수(기본 `true`)로 결정 — 위
  "Phase 1 구현 완료"의 근거 참고. `example-env`에 문서화.
- [x] `docs/egress-netgate.md` 신규 작성 (moby #50326, 쉬운 설명, 위험 패턴 경고, 못
  막는 것 두 가지, "당장 인터넷이 필요하다면" 수동 롤백 절차 전부 포함) +
  `docs/index.md`에 링크 추가.
- [x] `CLAUDE.md`의 "docker-compose topology" 절을 새 토폴로지(code-docker-external
  제거됨)에 맞게 갱신 + 새 "egress lockdown (netgate)" 절 추가.
- [x] 실측 검증 (격리된 워크트리, throwaway netgate 스텁) — 위 "Phase 1 구현 완료" 참고.
- [x] `agent-sandbox-hardening.md` 3번 항목 갱신 — Phase 2 완료로 "구현됨"으로 갱신함(아래
  "Phase 2 구현 완료" 참고).

### Phase 2 (netgate 자체) — 완료 (2026-08-05, 별도 작업 세션)

- [x] `Dockerfile`에 `netgate` 스테이지 추가 (archlinux 베이스 + squid + iptables +
  supervisor + yq + openssl — dante/SOCKS5는 "결정됨" 4번대로 불필요해서 안 넣음).
- [x] `config/netgate/squid.default.conf` — CIDR이 아니라 블록리스트 파일 *경로*만
  `${NETGATE_BLOCKLIST_PATH}`로 envsubst 치환(`config/netgate/squid.default.sh`가 처리) —
  CIDR 자체는 squid가 아니라 iptables(firewall.default.sh) 담당이라 애초에 squid.conf에
  주입할 필요가 없었음. 템플릿 패턴 하나로 충분, 별도 override 패턴 안 늘림.
- [x] SOCKS5(dante) — "결정됨" 4번대로 불필요, 구현 안 함.
- [x] `config/netgate/config.default.yaml` — 계획대로 순서 보존 `outbound:` CIDR
  리스트 + `forwards:` 포트포워딩(대상 호스트:포트, 소스 IP ACL은 이번 라운드엔
  안 넣음 - 필요성 확인 안 됨, 향후 확장 항목으로 남김). `config/netgate/firewall.default.sh`가
  30초 주기 루프로 읽어 iptables 규칙으로 변환(계획엔 없었던 디테일: 대상 컨테이너의
  IP가 재시작으로 바뀔 수 있어 매번 재해석하도록 일회성이 아니라 반복 루프로 구현 —
  아래 "구현 시 확인/정정한 것들" 참고).
- [x] 블록리스트 변환 스크립트 `script/netgate-blocklist.sh` — hosts 포맷
  (`0.0.0.0 evil.com`) → squid `dstdomain` ACL 파일(도메인 한 줄에 하나) 변환. 빌드 시
  StevenBlack/hosts를 받아 굽고, `config/netgate/blocklist.override.acl`(이미
  dstdomain 포맷)로 런타임에 override 가능.
- [x] `docker-compose.yml`: `code-docker-netgate` 서비스 추가 (`code-docker-internal` +
  `code-docker-external` 양쪽, `cap_add: [NET_ADMIN]`만, `privileged: true` 없음).
  `ports: - "80:80"`을 code-docker에서 여기로 이전, 인바운드 DNAT 설정 추가
  (RFC1918 DROP 룰보다 먼저 오도록 순서 적용, 실측 확인).
- [x] Phase 1 throwaway netgate 스텁(alpine sleep infinity) 자체는 이미 Phase 1 세션
  종료 시점에 제거되어 있었음(docker-compose.yml에 그 사실을 기록한 주석만 남아있었음) -
  Phase 2 세션에서는 그 주석을 실제 `code-docker-netgate` 서비스로 교체.
- [x] 실측 검증 — 아래 "Phase 2 구현 완료" 절 참고.

## Phase 2 구현 완료 (2026-08-05)

**구현물**: `Dockerfile`의 `netgate` 스테이지, `config/netgate/{config,firewall,squid}.default.*`
+ `config/netgate/supervisord.default.conf`, `script/netgate-{entrypoint,firewall,squid,blocklist}.sh`,
`docker-compose.yml`의 `code-docker-netgate` 서비스(`cap_add: [NET_ADMIN]`만,
`code-docker-internal`+`code-docker-external` 양쪽, `sysctls: [net.ipv4.ip_forward=1]`,
`ports: - "80:80"`). `netgate`는 계획대로 supervisord 기반(`[program:netgate-firewall]`,
`[program:squid]`, `[include] .../supervisord/*.conf`로 향후 라우터 확장 대비)으로
처음부터 구성함 — `functional-router-plan.md`가 요구하는 구조 요건 충족.

### 테스트 환경 — 실측 검증 방법

Phase 1과 동일하게 **격리된 워크트리에서, `PREFIX=egtest2-`로 실제 운영 중인 인스턴스와
완전히 분리**해서 진행. 단, 이번 라운드는 이 워크트리가 떠 있는 개발 호스트 자체에
**호스트 포트 80을 이미 점유 중인 실제 운영 code-docker 인스턴스가 있어서**, 테스트
동안만 `code-docker-netgate`의 `ports:`를 `"18080:80"`으로 임시 변경해 사용하고(운영
인스턴스를 절대 건드리지 않기 위함 - Docker의 호스트 포트 게시는 이 워크트리 안에서
컨테이너 netns에 도달하기 전 호스트 자신의 iptables에서 일어나는 별개의 DNAT라
`18080:80`이든 `80:80`이든 netgate 내부 로직(REDIRECT/DNAT 체인)에는 완전히 동일하게
적용됨 - 테스트 후 `docker-compose.yml`은 다시 `80:80`으로 되돌리고 커밋 대상 파일에는
반영하지 않음), 모든 검증이 끝난 뒤 정확히 `80:80`으로 되돌렸음(`git diff`로 최종
상태가 계획대로 `80:80`인 것 확인).

**중요한 환경 제약 발견**: 이 개발 샌드박스 자체가 **일반 Docker 브리지 네트워크로
연결된 컨테이너에서는 DNS 이름풀이가 아예 안 되는** 환경이었음(`network: host`로 빌드할
때만 진짜 DNS가 됨 - `docker build --network host`의 pacman/curl은 항상 성공했지만).
`docker run --rm alpine getent hosts example.com`처럼 **netgate/이 레포와 전혀 무관한
순정 컨테이너**로도 재현되는 걸 확인해서, 이건 내 구현의 버그가 아니라 순수히 이 샌드박스
자체의 네트워크 정책(아마 아웃바운드 DNS를 컨테이너 브리지 경로에서 막아둠)이라고 결론
내림. 이 제약 때문에 도메인 이름 기반 테스트 상당수는 `curl --resolve
<도메인>:<포트>:<실제IP>`로 DNS 단계를 우회하고 실제 목적지 IP만 사용하는 방식으로
우회해서 진행함(라우팅/방화벽/squid 로직 자체는 100% 실제 경로를 타되, DNS 단계만
건너뜀) - 이 우회가 필요했던 이유와 한계는 아래 "확인 못 한 것"에 정확히 기록함.

### 실측 검증 결과

- **라우트 테이블**: `docker exec code-docker ip route show` → `default via
  <netgate-IP> dev eth1` + connected route만 존재(이전 Phase 1과 동일 패턴, 이제
  `<netgate-IP>`가 실제 살아있는 netgate 컨테이너를 가리킴). dind도 동일하게
  `default via <netgate-IP>`.
- **(a) 정상 공개 호스트로의 curl 성공**: `curl --resolve github.com:80:140.82.112.3
  http://github.com/` (실제 github.com IP, DNS는 위 제약으로 우회) → `HTTP=301`(진짜
  GitHub 응답) - code-docker → netinit 라우트 → netgate FORWARD/MASQUERADE → squid
  REDIRECT 가로채기(3129) → dstdomain 블록리스트 통과(등록 안 됨 확인) → 실제
  인터넷까지 왕복 성공을 완전한 경로로 확인.
- **(b) 사설 대역 차단**: `curl -m4 http://192.168.1.1/`, `ping 192.168.1.1` 둘 다
  타임아웃/100% 손실. `iptables -L NETGATE-FORWARD -v -n`으로 `192.168.0.0/16 DROP`
  규칙의 패킷 카운터가 실제로 증가하는 것까지 확인(진짜로 그 규칙이 발동했다는 증거,
  단순히 목적지가 안 열려 있어서 실패한 게 아님).
- **(c) 블록리스트 차단/통과 대조**: HTTP - `curl --resolve doubleclick.net:80:1.1.1.1
  http://doubleclick.net/` → `HTTP=403`(squid 자체 차단 페이지, access.log에
  `TCP_DENIED/403`), 같은 방식으로 `github.com` → `HTTP=301`(정상 통과) - 정확히 대조되는
  결과로 dstdomain 블록리스트가 실제로 동작함을 확인. HTTPS(SNI 기반 `ssl_bump
  terminate`)도 간접적으로 확인함 - `doubleclick.net` HTTPS 시도는 squid cache.log에
  아무 보안 경고도 없이 조용히 연결이 끊김(= step1에서 SNI만 보고 즉시 terminate,
  DNS 필요 없음), 반면 정상 도메인(`github.com`) HTTPS 시도는 다른 이유로 막힘(아래
  "확인 못 한 것" 참고) - 이 비대칭 자체가 blocklist_sni + terminate가 DNS 없이도
  독립적으로 먼저 발동한다는 증거.
- **(d) 인바운드 DNAT**: `curl -I http://127.0.0.1:18080/` → nginx가 응답(`Server:
  nginx/1.30.4` 헤더 확인) - 호스트 포트가 netgate의 PREROUTING DNAT를 거쳐
  code-docker의 nginx까지 실제로 도달하는 것을 확인. (첫 라운드는 502를 반환했는데,
  이건 netgate/DNAT 문제가 아니라 code-server 자신이 이 샌드박스의 DNS 제약 때문에
  자기 최신 버전 체크에 실패해 계속 재시도 중이라 업스트림이 아직 안 뜬 상태였던
  것 - nginx가 정상적으로 응답하고 있다는 사실 자체가 DNAT 경로는 이미 완전히 살아있다는
  증거.)
- **(e) 같은 서브넷 통신**: code-docker ↔ dind, code-docker ↔ netgate, dind ↔ netgate
  전부 `ping` 정상(패킷 손실 0%) - RFC1918 차단 규칙이 같은 브리지 위 통신에는 영향 없음을
  재확인(설계 문서의 "정정" 절 예측대로).
- **(f) dind 아웃바운드**: `ping 192.168.1.1`은 손실, `nc -zv 140.82.112.3 80/443`은
  둘 다 open(진짜 인터넷 도달) - dind 전용 코드를 한 줄도 추가하지 않고 code-docker와
  동일한 필터링이 자연스럽게 적용됨을 확인(계획 문서 예측대로).
- **moby/moby#50326 재확인**: 아래 "발견하고 고친 버그들" 절의 qs_setup 크래시루프
  때문에 code-docker가 테스트 중 20회 이상 반복 재시작됐는데, 그때마다
  `code-docker-netinit`이 매번 정상적으로 고아 netns를 감지(exit 1) →
  `restart: unless-stopped`로 재기동 → 새 netns에 재합류 → 라우트 재적용까지 자동으로
  해내는 것을 의도치 않게(하지만 매우 광범위하게) 재확인함 - Phase 1 때 한 번
  `docker restart`로 확인했던 것보다 훨씬 많은 반복으로 이 복원력이 검증됨.

### 발견하고 고친 버그들 (계획에 없던 실제 버그 3건)

구현하면서 계획 문서에 없던 실제 버그 3개를 발견하고 고쳤음 - 전부 실제로 재현시켜서
확인 후 수정, 재현 안 되는 걸 짐작으로 고치지 않았음.

1. **`yq`가 mikefarah/yq(Go)가 아니라 kislyuk/yq(Python, 내부적으로 jq를 통해 JSON으로
   변환)였음** - `config/build.default.sh`가 pacman으로 설치하는 `yq` 패키지가 이
   버전이라, `yq '.outbound[0].action' config.yaml`의 기본 출력이 `block`이 아니라
   JSON 문자열 그대로인 `"block"`(따옴표 포함)이었음. 그 결과 `case "$action" in
   allow|block)` 매칭이 전부 실패(`unknown action '"block"'`)했고, `getent hosts
   "$target_host"`도 `"code-docker"`(따옴표 포함)라는 존재하지 않는 호스트명을 찾으려
   해서 매번 실패했음 - `iptables -L NETGATE-FORWARD`가 완전히 텅 비어 있는 채로 방치될
   뻔한, 조용히 전면 무방비 상태가 되는 심각한 버그였음(다행히 "만들다 만 상태로 열어둠"이
   아니라 규칙 자체가 하나도 안 생기는 형태라 실패가 눈에 잘 띄었음). **수정**:
   `config/netgate/firewall.default.sh`의 모든 스칼라 값 추출에 `yq -r`(raw output) 추가.
   **참고(이번 범위 밖, 건드리지 않음)**: 같은 성격의 잠재적 버그가 기존
   `config/tailscale-forward.default.sh`의 `remote_host` 추출에도 있음(문자열인데
   `-r` 없음) - `forwards:`가 기본으로 비어 있어서 지금까지 한 번도 발현되지 않았을 뿐.
   Phase 2 범위가 아니라 고치지 않았지만, 다음에 `tailscale-forward` 쪽을 만질 때 참고할
   가치가 있어 기록.
2. **`sysctl -w net.ipv4.ip_forward=1`이 `NET_ADMIN`이 있어도 런타임에 권한 거부로
   실패함** - Docker가 비특권(non-privileged) 컨테이너의 `/proc/sys`를 capability와
   무관하게 읽기 전용으로 마운트하기 때문. 이 샌드박스에서는 우연히 이 값이 이미 1이라
   포워딩 자체는 동작했지만(그래서 겉으로는 안 드러남), 기본값이 0인 호스트에서는 조용히
   전체 포워딩이 실패했을 것. **수정**: `docker-compose.yml`의 `code-docker-netgate`
   서비스에 `sysctls: [net.ipv4.ip_forward=1]`을 선언적으로 추가하고, 스크립트의 런타임
   `sysctl -w` 호출은 제거.
3. **`NETGATE-FORWARD` 체인에 상태 기반(ESTABLISHED,RELATED) ACCEPT 규칙이 없었음** -
   인바운드 DNAT(호스트:80 → code-docker:80)의 SYN은 통과했지만, 그 응답(SYN-ACK 등
   RETURN 트래픽)이 다시 `NETGATE-FORWARD`를 통과할 때 목적지가 원래 클라이언트(이
   샌드박스에서는 도커 브리지 게이트웨이 IP, 그 자체가 `172.16.0.0/12` RFC1918 대역
   안이라)라서 우리가 만든 RFC1918 DROP 규칙에 걸려 응답이 조용히 사라졌음(연결은
   맺히는데 응답이 안 오는, 원인 파악이 까다로운 유형의 버그) - 실측으로
   `curl http://127.0.0.1:18080/`이 타임아웃하는 것으로 처음 발견, `iptables -L
   NETGATE-FORWARD -v -n`으로 DNAT는 맞았는데 응답 경로가 막히는 걸 카운터로 확인.
   **수정**: `NETGATE-FORWARD` 체인 맨 앞에 `-m conntrack --ctstate ESTABLISHED,RELATED
   -j ACCEPT` 추가 - 표준적인 상태 기반 방화벽 패턴이고, NEW 상태의 아웃바운드 연결
   필터링(RFC1918 차단)에는 전혀 영향 없음(이미 허용된 연결의 응답만 재평가를 건너뜀).

이 외에 계획에는 없었지만 필요했던 구현 디테일: squid의 `ssl-bump`가
`generate-host-certificates`를 켜지 않아도(peek+splice/terminate만 쓰는데도) 인증서
캐시 DB(`/var/cache/squid/ssl_db`)가 초기화돼 있지 않으면 `sslcrtd_program` 헬퍼가
크래시루프에 빠짐 - 빌드 시점에 `security_file_certgen -c -s ...`로 한 번 초기화해서
해결.

### 확인 못 한 것 (솔직한 한계)

1. **HTTPS splice 경로(정상 도메인)의 완전한 종단 검증은 이 샌드박스에서 불가능했음.**
   squid의 `ssl_bump`는 가로챈 원 목적지 IP가 SNI 호스트명의 실제 DNS 해석 결과와
   일치하는지 자체적으로 검증하는 스푸핑 방지 기능이 있는데(`SECURITY ALERT: Host
   header forgery detected` 로그로 확인), 이 검증은 **squid 자신의 DNS 해석**이 되어야
   통과함 - 그런데 이 샌드박스는 netgate 컨테이너를 포함해 모든 일반 브리지 컨테이너의
   DNS가 막혀 있어서, `--resolve` 트릭으로 넘긴 (도메인, 실제 IP) 쌍이 진짜로 맞는
   조합이어도(`github.com` ↔ `140.82.112.3`) squid 자신이 그걸 검증할 방법이 없어
   차단됨. 이건 **차단된 도메인이 아니라 정상 도메인에서도 발생**했으므로, "정상 HTTPS
   트래픽이 실제로 통과하는지"는 이 환경에서 끝까지 증명하지 못함. 다만 근거는 있음:
   (1) 문제의 매커니즘이 squid의 문서화된 표준 anti-spoofing 기능이라 실제 DNS가 되는
   호스트에서는 정상 동작할 것으로 추정되고, (2) 차단 경로(`ssl_bump terminate`)는 이
   검증 이전 단계(step1, SNI만 봄)에서 이미 끝나므로 DNS와 무관하게 독립적으로 동작함을
   확인했음(위 "실측 검증 결과" (c) 참고) - 하지만 이건 여전히 **추정이지 실측 확인이
   아님**, 실제 DNS가 되는 환경에서 재검증 권장.
2. **qs_setup 첫 부팅 플로우가 "이제 인터넷이 있으니 깔끔하게 해소된다"는 걸 확정적으로
   증명하지 못했음.** 오히려 Phase 1이 예측했던 크래시루프가 **똑같이 재현**됐음 -
   `user-init.default.sh`의 `fish -c "curl ... | source && qs_setup"`가 계속 실패해서
   `set -e`에 걸려 컨테이너가 무한 재시작함. 원인을 추적한 결과 이건 netgate의 버그가
   아니라 **이 샌드박스 자체의 DNS 제약**이 원인임을 확인함(`docker run --rm alpine
   getent hosts example.com`이 netgate/이 레포와 완전히 무관하게 똑같이 실패 - 방금
   생성한 순정 컨테이너로도 재현) - `raw.githubusercontent.com`을 절대 못 찾으니 curl이
   매번 빈 결과를 내고, `source`가 빈 입력을 받아 아무 것도 안 정의하고, `qs_setup`
   명령이 없다는 에러로 fish가 비정상 종료(exit 127)하는 구조. 이건 **딱 한 번만
   성공하면 영구히 해소되는 종류**(`migration-version` 파일에 기록되고 다시는 이
   블록을 안 탐)라, DNS가 정상인 환경에서는 첫 시도에 성공해서 이 문제 자체가 발생하지
   않을 것으로 강하게 추정하지만(실제 공개 인터넷 IP로의 접근 자체는 (a)/(f)에서
   확실히 증명됨), **이 문서가 "확인함"이라고 주장할 수 있는 건 "크래시루프가 실제로
   재현된다"는 것과 "이 특정 샌드박스에서는 근본 원인이 DNS이지 netgate 로직이 아니다"
   까지이지, "실사용 환경에서 깔끔하게 해소된다"는 것 자체는 실측하지 못했음** -
   사용자가 실제 배포 환경에서 첫 부팅 시 이 부분을 한 번 눈으로 확인하는 걸 권장.

### 다음 세션을 위한 남은 항목

- `agent-sandbox-hardening.md` 3번 항목을 "구현됨"으로 갱신함(완료).
- 위 "확인 못 한 것" 두 가지는 실제 DNS가 되는(이 샌드박스가 아닌) 환경에서 재검증 권장 -
  코드 자체를 못 믿을 이유는 없지만(메커니즘상 타당성은 확인함), 다음에 이 기능을 만질
  기회가 있으면 우선순위로 확인.
- `config/tailscale-forward.default.sh`의 `remote_host` yq 추출에 있는 잠재적 동일 버그
  (위 "발견하고 고친 버그들" 1번 참고) - 이번 범위 밖이라 안 건드렸지만 다음에
  tailscale-forward를 만질 때 같이 고칠 가치 있음.

## 결정됨 (2026-08-05 논의로 확정)

1. **1단계(netns 공유로 투명 라우팅) + 2단계(netgate) 둘 다 채택.** 구현 순서는
   netinit(1단계) 먼저, netgate(2단계) 나중 — 위 "구현 순서 결정됨" 참고.
2. **CIDR/콘텐츠 리스트 둘 다 blocklist로 통일.** whitelist 모드는 별도로 구현하지
   않음 — 원하는 사용자는 blocklist 룰을 뒤집어 직접 whitelist처럼 쓸 수 있음. 근거는
   위 "액티브 방어 vs 패시브 방어" 참고.
3. **블록리스트 원본은 표준 범용 리스트(StevenBlack/hosts 등)로 충분.** 프롬프트
   인젝션 특화 리스트는 불필요.
4. **SOCKS5(dante)는 불필요.** 1단계(투명 L3 라우팅)를 채택했으므로 모든 프로토콜이
   이미 netgate를 거쳐 나감 — squid는 HTTP(S) 콘텐츠 필터링(TPROXY) 전용으로만 필요.
5. **dind의 아웃바운드도 포함.** 구현은 별도 사이드카 없이 dind 자신의 entrypoint에
   루프 추가 — 위 "솔직한 한계" dind 항목 참고.
6. **기본값 켜짐 + 옵트아웃 가능 — `NETGATE_ENABLED` 환경변수로 결정 (Phase 1
   구현 완료, `profiles:`는 기각).** `profiles:`는 Compose의 opt-in 설계상 "`.env`가
   아예 없어도 기본 켜짐"을 표현할 수 없어서 기각했다 — 위 "Phase 1 구현 완료" 절의
   해당 항목 참고. `TAILSCALE_ENABLED`와 동일한 패턴(서비스는 항상 뜨되 엔트리포인트가
   런타임에 idle로 빠짐)으로 구현했고, 네트워크 토폴로지(`code-docker-external` 제거)
   자체는 이 변수로 되돌릴 수 없다는 것도 명시적으로 결정/문서화됨.

## 구현 전 남은 실무 디테일 → 전부 해소됨 (Phase 1 구현 완료, 2026-08-05)

- netinit의 좀비/고아 netns 방지 방식: **exit+restart로 확정** (내부 루프 재시도는
  죽은 netns에서 근본적으로 무의미함을 실측으로 확인 — 위 "Phase 1 구현 완료" 참고).
- 옵트아웃: **`NETGATE_ENABLED` 환경변수로 확정** (위 "결정됨" 6번 참고).
- dind 루프의 좀비 프로세스 방지: **`tini --`로 최종 `exec`를 감싸는 것으로 확정**,
  실측으로 정상 동작 확인 (`ps aux`에서 `tini`가 PID 1).

## 참고

- `.claude/backlog/agent-sandbox-hardening.md` 3번 항목의 후속.
- `.claude/backlog/dind-authz-plan.md` — "code-docker보다 신뢰된 별도 컨테이너에
  정책을 두고, code-docker는 그 정책 파일에 손도 못 대게 한다"는 동일한 설계 원칙을
  이미 dind에 적용해 성공한 선례.
- CLAUDE.md의 tailscale 절 — `outbound: socat 피드 through tailscaled의 로컬 SOCKS5
  프록시`가 이미 이 레포에 있는 "애플리케이션 레벨 릴레이" 패턴의 선례.

### 외부 조사 출처 (2026-08-05, netns 공유 설계 검증용)

- [Docker Compose networking 공식 문서](https://docs.docker.com/compose/how-tos/networking/),
  [Sharing Network Namespaces in Docker (mikesir87)](https://blog.mikesir87.io/2019/03/sharing-network-namespaces-in-docker/) —
  `network_mode: "service:X"`가 인터페이스/IP/라우팅 테이블까지 완전히 공유한다는
  점, `network_mode: "service:..."`가 Compose의 의존성 해석(기동 순서)에 포함된다는
  점 확인.
- [Istio CNI 설치 문서](https://istio.io/latest/docs/setup/additional-setup/cni/),
  [How to Understand Istio's Init Container](https://oneuptime.com/blog/post/2026-02-24-how-to-understand-istios-init-container/view) —
  `istio-init`이 파드의 공유 netns에 `NET_ADMIN`/`NET_RAW`로 iptables 규칙을 심고
  종료하는, 이 설계와 동일한 패턴의 업계 표준 선례. Istio 1.10+부터 앱/사이드카
  컨테이너 자체는 무권한으로 운영됨.
- [Docker Tailscale Sidecar Pattern (Paul Welty)](https://www.paulwelty.com/how-i-eliminated-networking-complexity-docker-tailscale-sidecar-patterns/) —
  Docker Compose 규모에서 이 패턴(netns 소유 컨테이너 + `NET_ADMIN` 사이드카 + 무권한
  앱 컨테이너)을 실사용한 사례. "권한은 컨테이너 netns 안에만 머물러 호스트 네트워크는
  못 건드린다"는 결론, `SYS_MODULE` 같은 불필요한 cap을 추가하지 말라는 경고 확인.
- [moby/moby#50326](https://github.com/moby/moby/issues/50326) — netns 소유
  컨테이너가 재시작/중단되면 그 netns를 참조하던 컨테이너가 자동 기동 실패할 수 있는
  알려진 함정. 보안 이슈는 아니고 운영/가용성 이슈.
- [qdm12/gluetun](https://hub.docker.com/r/qmcgaw/gluetun) — 이 설계와 동일한
  메커니즘(NET_ADMIN 사이드카 + `network_mode: service:` 의존 컨테이너 + iptables
  킬스위치)을 쓰는 프로덕션급 선례. "iptables 규칙이 Docker 네트워크 초기화 이후
  적용돼 그 사이 ~15ms 창이 있다"는 알려진 한계가 문서화돼 있어, 이 설계의 유사한
  타이밍 리스크가 이 패턴 자체의 일반적 특성임을 뒷받침.
- [jpetazzo/squid-in-a-can](https://github.com/jpetazzo/squid-in-a-can) — netgate의
  squid 스테이지 베이스로 참고할 최소 예제.
- [Pugemon/docker-proxy-sidecar](https://github.com/Pugemon/docker-proxy-sidecar) —
  redsocks 기반 투명 프록시 사이드카, squid TPROXY가 막히는 경우의 대안 참고용.
