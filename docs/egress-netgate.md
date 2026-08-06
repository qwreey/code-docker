# 아웃바운드 네트워크 격리 (netgate)

code-docker 안에서 실행되는 AI 코딩 에이전트(Claude Code 등)가 프롬프트 인젝션이나
버그로 인해 컨테이너 바깥(인터넷, 특히 같은 네트워크 위 공유기/NAS 같은 사설망 장비)에
임의로 접근하지 못하게 막는 기능입니다. 전체 설계와 검토했다가 기각한 대안들은
[`.claude/backlog/egress-netgate-plan.md`](../.claude/backlog/egress-netgate-plan.md)에
정리되어 있습니다. 이 기능은 지금 **router** 컨테이너 안 한 기능 영역으로 통합되어
있습니다(`code-docker-router` 서비스, 예전 이름은 `code-docker-netgate`) — router의
다른 역할(tailscale, Dev Proxy 등)은 [router.md](router.md)를 확인하세요. 이 문서
안에서 "netgate"는 그 기능 영역 자체(iptables 필터링+squid+DNAT)를 가리키는 이름으로
계속 씁니다.

**현재 상태: 1단계(라우팅 강제)와 2단계(`netgate`의 실제 필터링)가 모두 구현되어
있습니다.** `docker compose up`만으로 code-docker/dind의 아웃바운드가 실제로
필터링되고, 인바운드 포트 80도 정상적으로 동작합니다.

## 쉬운 설명

- code-docker/dind는 `code-docker-external`(인터넷으로 나가는 네트워크)에 직접 붙어있지
  않습니다. 대신 `code-docker-netinit`이라는 작은 사이드카가 code-docker의 네트워크 설정
  안에 계속 "기본 게이트웨이는 `router`다"라는 라우트를 심어둡니다. code-docker 자신은
  이 설정을 바꿀 권한(`NET_ADMIN`)이 없으므로, 프롬프트 인젝션으로 오염된 에이전트가 셸
  명령을 마음대로 실행해도 이 라우트를 스스로 바꿀 수 없습니다.
- `code-docker-router` 컨테이너가 실제 국경(border) 역할을 합니다 - `code-docker-internal`
  과 `code-docker-external` 양쪽에 다리를 걸치고, 사설 대역(RFC1918)으로 나가는 트래픽을
  차단하고, HTTP(S)는 squid로 도메인 블록리스트를 적용하고, 호스트의 포트 80을
  code-docker로 전달(포트포워딩)합니다.
- **차단은 목적지 IP 기준입니다.** 같은 네트워크(`code-docker-internal`)에 붙어있는 다른
  컨테이너(dind, router 자신 등)로 가는 트래픽은 애초에 netgate 필터링을 거치지 않고
  바로 갑니다 - "그냥 아무 IP나 다 막아준다"는 뜻이 아닙니다.

### "같은 서브넷은 게이트웨이를 거치지 않는다"는 게 무슨 뜻인가요

일반적인 라우팅에서, 목적지가 **나와 같은 네트워크 대역(서브넷) 안**에 있으면 컴퓨터는
게이트웨이(라우터)에게 물어보지 않고 그 목적지에 바로 패킷을 보냅니다 - 마치 같은 건물
안 옆방에 갈 때 건물 정문 경비원을 거치지 않는 것과 같습니다. `code-docker`,
`code-docker-dind`, `code-docker-router`는 모두 `code-docker-internal`이라는 같은
서브넷 위에 있으므로, 이들끼리 주고받는 트래픽(`code-docker → dind`,
`code-docker → router` 등)은 애초에 netgate의 필터링 로직을 거치지 않습니다 - 라우팅의
기본 동작(connected route)이 게이트웨이를 자동으로 우회시키기 때문입니다. netgate의
RFC1918 차단 규칙이 `code-docker-internal` 자신의 대역(예: `172.22.0.0/16`)까지
막아버리는 게 아닌가 걱정할 필요는 없습니다 - 애초에 그 트래픽은 규칙이 적용되는 지점
(netgate의 FORWARD 체인)까지 도달하지 않기 때문입니다. 반대로 진짜 사설망(가정용
공유기 뒤 `192.168.x.x` 같은, code-docker-internal이 아닌 다른 사설 대역)으로 나가는
트래픽은 반드시 netgate를 거치고, 그때 비로소 차단 규칙이 적용됩니다.

## 아키텍처

```
code-docker (code-docker-internal 전용, NET_ADMIN 없음)
   │  code-docker-netinit이 지속적으로 심어주는 라우트로 default gw = router
   ▼
code-docker-router (code-docker-internal + code-docker-external 양쪽)
   │  - ip_forward + MASQUERADE + FORWARD 순서 있는 allow/block 룰(RFC1918 등)
   │  - squid REDIRECT 가로채기 (dstdomain/SNI 블록리스트, HTTP(S))
   ▼
code-docker-external → 인터넷

호스트:80 → code-docker-router (PREROUTING DNAT) → code-docker:80 (nginx)

code-docker-netinit (network_mode: service:code-docker + NET_ADMIN, 방어적 루프로
   code-docker의 netns 안에 기본 라우트를 지속적으로 재적용)
```

- `router/config/netgate/config.default.yaml` - CIDR allow/block 순서 리스트(`outbound:`)와
  포트포워딩(`forwards:`)을 선언하는 설정 파일. `router/config/netgate/firewall.default.sh`가
  30초마다 이 파일을 읽어 iptables 규칙으로 변환합니다. 순서가 중요합니다 - iptables
  체인은 first-match-wins이므로, 구체적인 예외를 넓은 차단보다 먼저 배치해야 합니다.
- 기본 `outbound:` 값은 RFC1918(`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) +
  링크로컬(`169.254.0.0/16`) + 루프백(`127.0.0.0/8`)을 차단합니다.
- 기본 `forwards:` 값은 호스트 80번 포트를 `code-docker:80`으로 전달합니다. 이
  포트포워딩용 ACCEPT 규칙은 항상 RFC1918 차단 규칙보다 **먼저** 적용됩니다 -
  code-docker의 IP 자체가 RFC1918 대역에 속하기 때문입니다.
- squid는 `code-docker-internal`에서 들어오는 80/443 트래픽만 자신의 포트(3129/3130)로
  가로채도록 REDIRECT 규칙이 걸려 있고 (`intercept` 모드 - TLS를 까지 않고 SNI만
  들여다봄), StevenBlack/hosts 기반 블록리스트로 `dstdomain`/SNI 기준 차단합니다. HTTPS는
  MITM 없이 SNI만 보고 판단(`ssl_bump peek` → 매치 시 `terminate`, 아니면 `splice`로
  그대로 통과)하므로 인증서 발급/신뢰 스토어 관리가 필요 없습니다.

## 위험한 패턴 - 새 브리징 컨테이너를 즉흥적으로 추가하지 마세요

`code-docker-internal`과 `code-docker-external`(또는 호스트) 양쪽에 붙는 컨테이너는 그
자체로 `router`/dind와 동급의 신뢰 레벨을 가집니다. "외부 Caddy가 code-docker에 못
닿으니 중간에 프록시 컨테이너 하나 두자"는 식으로 `(외부 Caddy) → (새 브리징 컨테이너)
→ code-docker` 패턴을 즉흥적으로 추가하면, 이 락다운을 완전히 우회하는 새 구멍(그
브리징 컨테이너를 통해 나가는 길)이 생길 수 있습니다. **이런 요구가 생기면 netgate
자체를 확장하거나(예: `router/config/netgate/config.default.yaml`에 forwards 항목 추가) 기존
nginx/[Dev Proxy](dev-proxy.md) 메커니즘을 쓰세요 - 새 브리징 컨테이너를 추가하지
마세요.**

## 이 시스템으로 못 막는 것

두 가지 서로 다른 "이 시스템으로 못 막는 구멍"이 있고, 성격이 다르므로 구분합니다.

1. **사용자가 직접 새 경로를 여는 경우** - `code-docker-external`을 code-docker에 직접
   다시 붙이거나, 위처럼 브리징 컨테이너를 추가하는 경우. `code-docker-netinit`/dind가
   예상치 못한 추가 기본 게이트웨이를 발견하면 로그에 경고를 남기지만(`docker compose
   logs`), 자동으로 되돌리지는 않습니다 - 사용자의 의도적인 변경일 수도 있기 때문입니다.
2. **정상적으로 허용된 아웃바운드 연결이 그 자체로 우회 통로가 되는 경우** - 예를 들어
   어떤 정상 SaaS API가 요청 파라미터에 따라 다른 목적지로 릴레이/fetch 해주는 기능이
   있다면, 그 요청 자체는 netgate 입장에서 완전히 정상 트래픽이라 막을 방법이 없습니다.
   이건 code-docker 경계를 벗어난 원격 서버에서 일어나는 confused-deputy 패턴이라
   **네트워크 레이어의 어떤 통제로도 원천적으로 해결 불가능**합니다 - 사용자가 인지하고
   있어야 하는 한계로 명시합니다.

블록리스트(squid)는 애초에 "강제적으로 완벽히 막는다"가 목적이 아니라 프롬프트 인젝션
콘텐츠 오염에 대한 1차/best-effort 방어입니다 - 실제 강제 방어는 CIDR 차단(FORWARD
체인)이 담당합니다. 내부자(오염된 에이전트)가 작정하고 우회하려면(IP 직접 지정, 리스트에
없는 새 도메인 등) 얼마든지 우회 가능합니다.

## 운영상 알려진 함정 (moby/moby#50326)

`code-docker-netinit`은 `network_mode: service:code-docker`로 code-docker의 네트워크
네임스페이스를 공유합니다 - 즉 code-docker가 network namespace의 "소유주"입니다. Docker
엔진의 알려진 이슈([moby/moby#50326](https://github.com/moby/moby/issues/50326))로 인해,
code-docker 컨테이너 자체가 재시작되면(단순히 안의 프로세스가 재시작되는 게 아니라,
컨테이너가 통째로 재시작/재생성되는 경우) 그 네트워크 네임스페이스가 새로 만들어지고,
그 시점에 이미 붙어있던 `code-docker-netinit`은 옛(이제는 죽은) 네임스페이스에 고아로
남아 라우트를 전혀 심을 수 없는 상태가 됩니다.

**대응은 이미 구현되어 있습니다**: `script/netinit-entrypoint.sh`가 매 루프 시작마다
자신의 네트워크 인터페이스를 확인해서 loopback 외의 인터페이스가 하나도 없으면(= 고아가
된 옛 네임스페이스에 갇힌 것으로 판단) `exit 1`로 스스로 종료합니다.
`restart: unless-stopped`가 이를 감지해 컨테이너를 재생성하고, 그러면 현재 code-docker가
소유한 새 네트워크 네임스페이스에 다시 합류해 라우트를 정상적으로 재적용합니다. 이
사이클은 실측으로 수 초 안에 완료되는 것을 확인했습니다(아래 Phase 1+2 완료 절 참고).
재부팅 후에는 `docker compose ps`로 `code-docker-netinit`이 정상적으로 떠 있는지 한 번
확인하는 습관을 권장합니다.

## 당장 인터넷이 필요하다면 (기능 자체를 끄기)

`NETGATE_ENABLED="false"`(`.env`)로 끄면 `code-docker-netinit`/dind의 라우팅 루프,
code-docker 시작 시의 라우트 대기 가드, `code-docker-router` 자신의 방화벽/squid 적용이
전부 아무것도 안 하고 idle 상태가 됩니다 - `TAILSCALE_ENABLED`와 같은 패턴입니다. **다만
이것만으로는 예전(제한 없음) 토폴로지로 완전히 돌아가지는 않습니다** -
`code-docker-external`이 이미 code-docker/dind의 `networks:`에서 빠져 있고, `ports:
- 80:80`도 code-docker가 아니라 router 서비스에 있어서, `NETGATE_ENABLED=false`만으로는
code-docker 자신이 여전히 인터넷/호스트에 직접 나갈 인터페이스가 없습니다. Compose는
네트워크 attachment/포트 퍼블리시 여부를 런타임 환경변수로 조건부 처리할 수 없기 때문에,
완전히 예전 토폴로지로 되돌리려면 `docker-compose.yml`을 직접 수정해야 합니다:

- `code-docker`, `code-docker-dind` 두 서비스의 `networks:`에
  `code-docker-external: {}`를 다시 추가하세요.
- `code-docker`의 `ports:`에서 주석 처리된 `- 22:22`를 다시 살리고, `- 80:80`도
  추가하세요(원래 code-docker에 있던 포트입니다 - 지금은 `code-docker-router`
  서비스의 `ports:`에 있습니다, 그건 그대로 둬도 되고 지워도 됩니다).
- `NETGATE_ENABLED="false"`도 같이 설정해 두면 `code-docker-netinit`/dind가 굳이
  존재하는 `router`를 거칠 필요 없이 바로 나갈 수 있습니다(router 자체를 compose에서
  완전히 빼는 것도 가능하지만, 그건 tailscale/Dev Proxy까지 같이 잃는다는 뜻이라 이
  문서 범위 밖의 더 큰 수술입니다 - router.md 참고).

이건 `DIND_TARGET=dind`로 dind-authz 보호를 완전히 끄는 것과 같은 성격의, 의도적으로
눈에 띄는 수동 작업입니다.

## 설정 커스터마이징

`router/config/netgate/config.default.yaml`을 참고해서 `router/config/netgate/config.override.yaml`을
만들면(override 패턴, `docker compose build code-docker-router && docker compose up -d`
필요) `outbound:`(CIDR allow/block 순서 리스트)와 `forwards:`(포트포워딩)를 원하는 대로
바꿀 수 있습니다. squid 블록리스트도 같은 패턴으로
`router/config/netgate/blocklist.override.acl`(도메인 한 줄에 하나, squid `dstdomain` 형식)을
두면 기본 StevenBlack/hosts 기반 블록리스트 대신 사용됩니다 - 다른 hosts 포맷 소스에서
변환하려면 이미지 안의 `/etc/code-docker/netgate-blocklist.sh <입력> <출력>`(레포 안에서는
`router/script/netgate-blocklist.sh`)을 쓰세요.
