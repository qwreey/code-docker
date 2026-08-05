# router를 "네트워크 경계 전담 컨테이너"로 확장하는 구상 (초기 비전 문서)

작성일: 2026-08-05 — `egress-netgate-plan.md`(아웃바운드 CIDR 차단 + 인바운드 DNAT)를
설계/1단계 구현하는 과정에서, "이 router가 네트워크 경계에 이미 앉아 있으니 tailscale/
Caddy/외부 노출 인증까지 다 여기로 모으면 어떤가"라는 아이디어가 나와서 별도로 정리한
문서. **아직 설계 확정 전 — 방향성과 트레이드오프를 정리한 비전 문서에 가깝고, 상당
부분이 "결정 필요"로 열려 있음.** egress-netgate-plan.md의 netgate 구현에 영향을 주는
부분이 있어 그쪽에서도 상호 참조함.

## 핵심 아이디어

netgate(router)는 이미 `code-docker-internal` + `code-docker-external` 양쪽에 다리를
걸친, code-docker보다 신뢰 수준이 높은 유일한 국경 통과 지점이다. 그렇다면 "네트워크
경계와 관련된 모든 것"을 여기로 모으는 게 자연스럽지 않은가:

1. **tailscale을 code-docker가 아니라 router에서 실행.** 지금 code-docker 안의
   `tailscaled`가 0.0.0.0/loopback 바인드를 자동으로 tailnet 전체에 노출시키는 문제 때문에
   `private`/`forward` 전용 alias로 우회하고 있는데(CLAUDE.md tailscale 절), tailscaled가
   router로 옮겨가면 이 문제 자체가 code-docker 쪽에서 사라진다. router가 tailnet의 어떤
   범위(포트 단위든 IP 단위든)를 code-docker에 통과시킬지를 직접 결정 — tailscale ACL을
   안 건드리고도 해결됨.
2. **Caddy(현재 code-docker 안, Dev Proxy 기능)도 router로.** 외부 노출을 다루는 것도
   router의 본업과 같은 카테고리 — code-docker는 `private:80`같은 곡예 없이 그냥
   `0.0.0.0`에 바인드해도 됨(코드docker-internal은 이미 외부에서 도달 불가능하므로,
   router가 명시적으로 포트포워딩해주지 않는 한 노출 없음).
3. **router가 자체 forward-auth(비밀번호 게이트)를 가질 수 있음.** router 설정 API로
   임의 라우트에 비밀번호를 걸 수 있게 하면, code-docker(에이전트 포함)가 뭘 하든 그
   라우트 설정 자체를 못 바꿈 — dind-authz/netgate와 동일한 "정책은 더 신뢰된 컨테이너
   안에" 원칙의 연장.
4. **동기: 팀원에게 개발 서버를 빠르게 공유하는 워크플로우.** 빌드/배포/마이그레이션
   기다릴 필요 없이 `npm run dev` 옆에서 바로 라이브로 보여주고 싶은데, 그러자면 뭔가
   가벼운 접근 제어가 필요함. Authentik은 이 목적엔 너무 무겁고(멀티테넌시 불필요, 설정
   진입 장벽 큼) — router 안에 작은 auth 프로세스를 두고 `/router`(가칭, `/manager`와
   나란히)에서 설정하는 쪽이 훨씬 가벼움.

## 왜 이게 그럴듯한가 (검증된 부분)

- **신뢰 경계가 더 명확해짐.** Dev Proxy/외부 노출 관련 정책이 지금은 code-docker
  안에서 도는 webmanager 프로세스가 들고 있는데, router로 옮기면 code-docker(오염
  가능성이 있는 컨테이너) 자체가 그 정책 파일에 손도 못 대게 됨 — dind-authz의
  `/etc/dind-authz.d`, netgate의 CIDR 설정과 정확히 같은 패턴.
- **code-docker 쪽 네트워크 관련 코드/설정이 실질적으로 줄어듦.** tailscale
  private/forward 곡예, Dev Proxy의 nginx 경유 라우팅 등 여러 우회 장치가 필요 없어짐 —
  "네트워크는 전부 router가 안다"로 단순화.
- **위협 카테고리는 늘지 않음.** "관문 프로세스가 죽으면 못 들어온다"는 지금 nginx나
  옮긴 뒤 router나 동일한 종류의 리스크.

## 짚어야 할 트레이드오프 (2026-08-05 논의)

- **위협이 사라지는 게 아니라 한 곳에 응축된다.** 지금은 nginx가 죽어도 아웃바운드/
  tailscale/dev-proxy는 각자 영향이 제한적인데, router가 다 들고 있으면 router 장애
  하나가 인바운드+아웃바운드+tailscale+dev-proxy 전체를 같이 끌고 내려간다. 카테고리는
  같아도 blast radius는 커짐 — `restart: unless-stopped` + 이 레포의 tailscale 절이
  이미 쓰는 "의도적으로 분리된 단일 책임 supervisord 프로그램" 패턴을 router 안에서도
  반복해 개별 기능 하나의 버그가 다른 기능까지 끌고 내려가지 않게 해야 함.
- **router 자체가 webmanager의 전철을 밟을 위험.** webmanager도 처음엔 작았는데 지금은
  스스로 "원래 스코프를 훨씬 넘어섰다"고 문서화할 정도로 커졌음(CLAUDE.md webmanager
  절). router에 기능을 계속 추가하면 같은 일이 반복될 수 있음 — 처음부터 supervisord +
  단일 책임 프로그램 분리 규율을 지킬 것.
- **authgate와의 관계 — 결정됨(2026-08-05).** webmanager의 기존 authgate(Terminal/
  File Manager 보호용, `internal/authgate`)는 **그대로 유지, 변경 없음** — "자기
  자신만 건드리는 것"의 보호 수단으로 계속 씀. router 쪽 forward-auth는 완전히 별개의,
  더 가벼운 도구를 새로 둔다 — 아래 참고.

### router 전용 forward-auth — tinyauth로 결정

대안으로 tinyauth, (사용자가 언급한 다른 forward-auth 프로젝트들)을 검토했고,
**tinyauth로 결정**. 이유(사용자 판단): 목적(가벼운 개발 서버 공유용 게이트)에
비해 크지 않으면서도 OpenID Connect™ Certified라 향후 확장 여지가 있고, 이보다 나은
대안이 뚜렷하게 보이지 않음. router가 Caddy(또는 향후 결정될 리버스 프록시)의
forward-auth 대상으로 tinyauth를 세우는 구조가 될 것 — 세부 배선(compose 서비스 추가
방식, 설정 override 패턴 적용 등)은 실제 구현 시점에 확정.

### 읽기 전용 상태 API 필요 — tailscale 피어 상태/인증 URL

router가 tailscale을 들고 있게 되면, 지금 code-docker 안에서 하던 것과 같은 역할
(`tailscale-status.default.sh`가 `tailscale status --json`을 폴링해 `{backendState,
authUrl}`을 code-patch로 code-server에 노출하는 것 — CLAUDE.md tailscale 절 참고)을
router도 제공해야 함 — 로그인 대기 상태를 사용자가 code-server 안에서 바로 볼 수
있어야 하므로. **적절히 필터링된 읽기 전용 API**(tailscale 피어 상태, 인증 상태/URL)
정도는 인증 없이 노출해도 된다는 게 사용자 판단 — 쓰기 동작이 아니라 상태 조회일
뿐이므로 tinyauth/authgate 대상에서 제외 가능. 세부 스펙(정확히 뭘 얼마나 필터링해서
내보낼지)은 실제 구현 시점에 확정.
- **webmanager 자체의 스코프 축소.** Dev Proxy 관련 기능이 router로 넘어가면
  `webmanager/plan.md`/`webmanager/CLAUDE.md`도 갱신 대상이 됨 — 이건 이 문서(code-docker
  루트)가 아니라 webmanager 서브트리 쪽에서 별도로 다뤄야 할 후속 작업.

## 프론트엔드 구조 (사용자가 "크리티컬하지 않으니 알아서 결정해도 됨"이라 명시함)

공유 UI 킷을 만들고, 다음 의존 관계로 구성하는 안:

```
shared → router     (router 자체의 /router UI가 shared 컴포넌트 사용)
shared → webmanager (webmanager도 같은 shared 컴포넌트 사용)
router → webmanager (webmanager가 router의 페이지 컴포넌트를 그대로 import해서
                      /manager 안에 통합 — iframe 안 씀, 진짜 컴포넌트 임포트)
```

`/manager`를 통합 UI 진입점으로 유지하되, `/router`도 router 컨테이너 자체에서 독립
접근 가능하게 두는 방향. 실제 구현 시점에 세부 조정 가능 — 지금 확정할 필요 없음.

## netgate(egress-netgate-plan.md)에 대한 영향 — 지금 당장 반영해야 할 것

이 비전이 아직 확정 전이라도, **지금 만드는 netgate(2단계) 자체가 나중에 이 방향으로
확장 가능한 구조여야 한다.** 구체적으로:

- netgate의 Dockerfile/entrypoint를 **처음부터 supervisord 기반으로 구성** — 지금은
  squid + iptables 설정 스크립트 하나뿐이더라도, 나중에 tailscaled/Caddy/auth 프로세스가
  추가될 걸 감안해 "여러 개의 독립 프로그램을 관리하는 컨테이너" 구조로 시작. code-docker
  자신의 `config/supervisord.default.conf` + `config/supervisord/*.conf` 자동 include
  패턴을 그대로 재사용.
- 이미 결정된 "포트포워딩 설정을 yml로 선언"(egress-netgate-plan.md의 "포트포워딩
  일반화" 절)이 정확히 이 방향과 맞아떨어짐 — 지금 그대로 유지.
- netgate의 이름/역할을 "egress 전용"으로 문서상 너무 좁게 못박지 않기 — 나중에 이
  컨테이너가 "router"로 통칭될 수 있음을 염두에 두고 문서/변수명을 짓기(예:
  `NETGATE_ENABLED`는 이미 옵트아웃 변수로 확정됐으니 유지, 다만 향후 문서에서
  "netgate = router의 egress/DNAT 담당 부분"이라는 식으로 포지셔닝 여지를 남길 것).

## 결정 필요 (구현 착수 전)

1. router에 tailscaled를 실제로 옮길지, 옮긴다면 code-docker의 기존 tailscale 관련
   설정(config.yaml, private/forward alias, code-patch 알림 등)을 어떻게 마이그레이션할지.
2. Caddy(Dev Proxy)를 router로 옮길지, nginx와의 역할 분담을 정확히 어떻게 할지 —
   사용자는 "nginx는 계속 유지"(10MiB 메모리 풋프린트, Caddy 설정 실수 시 완전 장애
   리스크에 대한 보험) 의견을 이미 밝힘 — 이건 거의 결정된 것으로 보임.
3. ~~router 전용 경량 auth-gate~~ — **결정됨**: tinyauth, webmanager authgate는
   그대로 유지(위 "router 전용 forward-auth" 절 참고). 남은 건 배선 디테일뿐.
4. `/router` UI와 `/manager` UI의 정확한 통합 방식(위 프론트엔드 구조 초안 참고).
5. webmanager 쪽 plan.md/CLAUDE.md 갱신 범위 — 별도 세션/문서로 다룰 것.
6. 읽기 전용 tailscale 상태 API의 정확한 필터링 스펙(위 "읽기 전용 상태 API" 절 참고).

## 참고

- `.claude/backlog/egress-netgate-plan.md` — 이 문서의 전제가 되는 netgate 설계/1단계
  구현 완료 기록.
- CLAUDE.md의 tailscale 절 — "의도적으로 분리된 단일 책임 supervisord 프로그램" 패턴의
  기존 선례, router 안에서도 반복할 모델.
- `.claude/backlog/dind-authz-plan.md`, `webmanager/.claude/archive/authgate-plan-done.md`
  — "정책은 더 신뢰된 컨테이너/프로세스 안에" 원칙의 기존 적용 사례들, 이번 아이디어도
  같은 계열.
