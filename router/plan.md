# router 계획 (현재 상태 — 짧게 유지)

code-docker의 네트워크 경계를 전담하는 컨테이너. **이 문서는 지금 상태와 남은 할 일의
색인만** 담는다 — 전체 비전/설계 결정은 `.claude/functional-router-plan.md`
(왜 router가 필요한지, 무엇이 이관되는지, 이 서브트리로 이동됨)와 레포 루트
`.claude/backlog/egress-netgate-plan.md`(현재 이관된 egress/DNAT 기능의 원래 설계 —
code-docker/dind 쪽 netinit 루프도 다루는 문서라 레포 루트에 남음)에 있음.
`webmanager/plan.md`와 같은 패턴 — 기능별 자세한 문서는 `router/.claude/`에 쌓임
(`functional-router-plan.md`, `router-dns-plan.md`, `archive/tailscale-design.md`).

## 왜 필요한가

`code-docker-netgate`(iptables 아웃바운드 필터링 + DNS 레벨 콘텐츠 블록리스트 + 인바운드
DNAT)가 이미 code-docker-internal/external 양쪽에 다리를 걸친, code-docker보다 신뢰
수준이 높은 유일한 국경 통과 지점이었다. tailscale(데몬+forward+publish), Dev
Proxy(Caddy), 새 tinyauth 게이트까지 이 지점으로 모으면 신뢰 경계가 더 명확해지고
code-docker 쪽 네트워크 관련 코드/설정이 줄어든다 — 자세한 트레이드오프는
`.claude/functional-router-plan.md` 참고.

## 아키텍처

`router-manager`라는 Go 백엔드(webmanager와 같은 패턴, `router/backend`)와
`@code-docker/router-frontend`라는 React 프론트엔드 패키지(`router/frontend`, 레포 루트
npm workspace의 일원 — webmanager/frontend가 이 패키지의 컴포넌트를 실제로 import해서
씀)가 있다. `router/config/netgate/`, `router/script/netgate-*.sh` 아래 "netgate"는
router 안의 한 기능 영역(egress/DNAT) 이름으로 유지 — 컨테이너 전체 이름은 `router`.

## 구현 완료

| 기능 | 상태 |
|---|---|
| router 자체 nginx(host:80 직접 종단) + router-manager/Caddy admin 유닉스 소켓화 + Dev Proxy target 검증(기본 code-docker-internal만 허용) + router-manager 인앱 비밀번호 설정/변경 | 구현 완료·실컨테이너 검증 완료. 보안 감사에서 나온 두 CRITICAL 발견(target 미검증 SSRF, router-manager 무인증+직접 도달 가능)이 계기 — 자세한 내용: `.claude/router-nginx-hardening-plan.md` |
| netgate(iptables 아웃바운드 필터링, 인바운드 DNAT) | `code-docker-netgate`에서 이 컨테이너로 순수 이전 완료 — 동작 변화 없음 |
| DNS 포워딩(dnsmasq) — code-docker-internal이 `internal: true`라 Docker 내장 DNS가 외부 포워딩을 거부하는 문제 해결 | 구현 완료·커밋됨(`00bba1a`). 자세한 내용: `.claude/router-dns-plan.md` |
| squid 제거 + DNS 레벨 블록리스트(dnsmasq `addn-hosts`)로 교체 | 구현 완료. squid의 ssl-bump anti-spoofing이 CDN형 도메인(예: `registry-1.docker.io`)을 오탐해 `docker pull`을 깨뜨리는 버그가 계기 — 자세한 내용: `.claude/router-dns-plan.md`의 "2부" |
| tailscale 전체(데몬+로그인+forwards+publish) + router-manager 백엔드 | 이식 완료. `forward` alias는 이 컨테이너로 이동, `private`/bind-addr 기본값은 Phase 4 이후에도 code-docker 쪽에 남아있음 — 원래 code-docker 자신의 tailscaled가 쓰던 이유였지만 지금은 그냥 기존 기본값을 굳이 바꿀 이유가 없어서 유지 중(docker-compose.yml의 `private` alias 주석 참고) |
| Dev Proxy(Caddy) + tinyauth forward-auth | 이식 완료. `internal/devproxy`가 tinyauth를 타겟으로 렌더링하도록 변경(webmanager의 `/api/auth/verify` 대신). 실제 request → Caddy → tinyauth → 401+로그인 리다이렉트 체인까지 검증됨 |
| tinyauth를 별도 compose 서비스에서 router 내장 supervisord 프로그램으로 전환 | 완료(2026-08-07). 원래는 별도 `code-docker-tinyauth` 서비스(공식 이미지, 소스 빌드 아님 — pnpm 프론트엔드 빌드가 필수라 dind-authz 패턴과 안 맞음)였는데, `TINYAUTH_APPURL` 미설정 시 tinyauth가 즉시 부팅을 거부하면서 `restart: unless-stopped`로 무한 크래시 루프를 도는 문제가 있었음. `router/Dockerfile`이 멀티스테이지로 `ghcr.io/tinyauthapp/tinyauth`에서 빌드된 바이너리만 추출(`/usr/local/bin/tinyauth`)해 router 자신의 supervisord 프로그램으로 실행하도록 변경(`router/config/tinyauth/tinyauth.default.sh`) — `TINYAUTH_APPURL` 미설정 시 크래시 대신 `sleep infinity`로 대기(`CADDY_ADAPTER_ENABLED`/`TAILSCALE_ENABLED`와 같은 관례). `TinyauthTarget`도 `tinyauth:3000`(compose alias)에서 `127.0.0.1:3000`(같은 컨테이너 localhost)으로 변경. `TINYAUTH_VOLUME`/`tinyauth-data` 바인드 마운트는 없어지고 상태는 router 자신의 볼륨 아래 `/var/lib/code-docker-router/tinyauth`로 이동 |
| code-docker 컷오버 | 완료. code-docker에서 tailscale/caddy-adapter 완전 제거(프로세스 0개, 바이너리도 없음), nginx `/tailscale/`(router-manager readonly API)·`/exports/`(Dev Proxy) 라우트를 router로 배선, `tailscale-notify.default.js`가 새 엔드포인트를 폴링하도록 변경. 이제부터 code-docker는 tailscale/Dev Proxy에 대해 아무것도 모른다 |
| webmanager 통합 | 완료. `router/frontend` 신설(npm workspace), Dev Proxy 탭을 webmanager가 그 패키지에서 import — 실제 브라우저로 expose 생성까지 검증됨(라우팅 버그 하나 발견해서 즉시 수정: `/dev-proxy/` nginx 라우트가 빠져있었음). webmanager의 옛 Dev Proxy/Tailscale 백엔드·프론트엔드 코드 전부 삭제, DevAuth도 tinyauth로 대체되어 삭제 |
| 문서 정리 | 완료. `docs/router.md` 신설, `docs/tailscale.md`/`dev-proxy.md`/`egress-netgate.md`/`webmanager.md`/`webmanager-config.md`/`build-customization.md`/`index.md`/`tips/adb.md`와 레포 루트 `CLAUDE.md`를 새 구조에 맞게 갱신. 부수적으로 발견한 회귀도 하나 고침 — `bin/forward-reload`가 Phase 2 이후 조용히 깨져 있었음(code-docker 안에서 더 이상 존재하지 않는 supervisord 프로그램을 재시작하려 시도) |
| App Routes(경로 기반 `/app/<이름>/...` 리버스 프록시, Dev Proxy와 별개) | 구현 완료. 애초에 설계됐지만 문서 정리 과정에서 아예 빠져있던 게 뒤늦게 드러나 이번에 구현. Dev Proxy와 같은 Caddy 프로세스 안에 세 번째 site block(`unix//run/caddy-app.sock`, `apps/*.caddy` import) 추가, router 자체 nginx는 `location /app/` 고정 블록 하나만 추가(앱이 몇 개든 다시 안 바뀜). `internal/approutes` 신설(`internal/devproxy`의 `Expose`/`Route` 대신 플랫한 `App{Name,Target,RequireAuth}` — `handle_path`가 접두사를 자동으로 벗겨줘서 path/strip/rewrite/mode 필드가 필요 없음), self-SSRF 차단 로직은 `internal/targetguard`로 뽑아서 devproxy/approutes 둘 다 공유(중복 방지). `code → code-docker:80` 기본 앱은 `caddy-adapter.default.sh`가 `.migration-version` 카운터(`config/user-init/user-init.default.sh`와 같은 방식)로 최초 1회만 시딩. 자세한 내용: `docs/app-routes.md` |
| DNS 관리(블록리스트/추가 호스트/리졸버) | 구현 완료(2026-08-08). `internal/dns` 신설 — 블록리스트 소스 여러 개(builtin은 `blocklist.default.hosts`에서 code-patch 스타일 해시 추적으로 시딩, 커스텀은 웹에서 자유 추가), MagicDNS 스타일 추가 호스트(호스트명→실제 IP), 리졸버 오버라이드(`auto`/`custom` 업스트림 서버). `dns.default.sh`가 `blocklist-manifest`(builtin 부트스트랩/안전한 재적용) + `config.yaml`(리졸버) + `custom-hosts.hosts`/`blocklist-sources/*.hosts`(글롭, 여러 `--addn-hosts=`)를 조립. `blocklist.override.hosts`는 예전 그대로 항상 추가되는 별도 플래그로 유지(builtin 시딩에 접히지 않음 — 접었으면 "추가"였던 의미가 "대체"로 조용히 바뀌었을 것). router-manager `/api/dns/*` + router/frontend `Dns` 탭(webmanager에도 사이드바로 노출). netgate 설정에도 같은 재동기화 패턴을 적용해보려 했는데 netgate엔 "시딩된 라이브 카피" 개념 자체가 없어서 선행 작업이 필요하다는 게 드러나 백로그로 되돌림 — 자세한 설계/이유: `router/.claude/dns-blocklist-management-plan.md` |
| Net 관리 탭(netgate outbound CIDR + 포트포워딩 웹 관리), 탭 상태 URL 경로 반영(router+webmanager), tinyauth 비밀번호 변경, DNS 빌트인 블록리스트 opt-out/소스 마운트 override | 구현 완료(2026-08-08). netgate에도 DNS와 같은 "시딩된 라이브 카피" 패턴을 도입(위 DNS 항목이 백로그로 미뤘던 선행 작업) — `internal/netgate` 신설, `firewall.default.sh`가 라이브 카피를 매 루프마다 다시 확인. 나머지 3개는 각자 독립적인 작은 개선. 자세한 내용: `router/.claude/net-auth-expansion-plan.md` |
| DNS dig형 조회 도구(DNS 탭 "조회" 서브탭, ALL 옵션 포함) | 구현 완료(2026-08-09). `router/Dockerfile`에 `bind` 패키지 추가(dig 제공), `internal/dns/query.go`가 레코드 타입 allowlist 검증 후 이 컨테이너 자신의 dnsmasq(127.0.0.1)로 `dig` 실행, 원본 출력을 그대로 반환 — `GET /api/dns/query`, 읽기 전용이라 인증 게이트 밖. "도메인 타입" 쌍을 반복하면 dig 한 번으로 여러 레코드를 순서대로 조회한다는 점을 이용한 `ALL`(A/AAAA/CNAME/MX/TXT/NS/SOA/SRV) 특수 옵션도 추가. 캐시 상태/지우기는 요청 시점에 이미 스코프 아웃됨. 자세한 내용: `router/.claude/net-auth-expansion-plan.md`의 7번 |
| router 자신의 사이드바(잠금 상태 + 테마 토글 포함) + tinyauth 전용 탭 분리 | 구현 완료(2026-08-09). `router/frontend/src/components/Layout/`(Sidebar/SidebarContainer/SidebarFooter/Layout.css)와 `theme.ts`/`useTheme.ts`를 webmanager 것에서 hand-kept-duplicate로 복사 — router는 이제 플랫 탭바 대신 자기 사이드바를 쓰고(order는 로컬 상태만, 서버 영속화 없음), standalone 방문에서 잠금 상태(`GET /api/auth/status` 기반)와 라이트/다크/자동 테마 토글을 직접 제공(embed 모드는 여전히 부모 postMessage 기반). `TinyauthUsers`를 '설정' 탭에서 분리해 독립 `tinyauth` 탭으로, webmanager `RouterFrame`/사이드바에도 새 항목으로 배선해 webmanager에서도 그대로 관리 가능. 자세한 내용: `router/.claude/net-auth-expansion-plan.md`의 5/6번 후속 |
| 대역폭 제한(`tc` HTB, 전체 하드캡 + 컨테이너별 독립 하드캡) + webmanager에 "Router 설정" 탭 추가 | 구현 완료(2026-08-10). `internal/netgate`에 `Bandwidth{TotalMbps, Services[]}` 추가, `GET`/`PUT /api/netgate/bandwidth` — `outbound:`/`forwards:`가 *어디로*를 통제한다면 이건 *얼마나 빠르게*를 통제, 네트워크 소진 공격 방어 목적. `netgate-firewall`과 별도 supervisord 프로그램(`netgate-shaping`, `shaping.default.sh`)이 30초마다 기본 인터페이스에 HTB 트리를 다시 적용 — root class(전체 하드캡, 0=무제한)에 서비스별 child class(rate==ceil, 서로 borrow 안 함)를 `target_host`의 소스 IP로 필터링해 매단다. "Net 관리" 탭에 카드로 추가(router/frontend `Bandwidth.tsx`). 겸사겸사 webmanager 쪽에서 router의 "설정"(router-manager 자체 인증) 탭만 유일하게 iframe embed가 안 돼 있던 걸 발견해서 같이 추가(`router-settings` 섹션, `RouterFrame` tab="settings") — 이제 6개가 아니라 7개 탭 전부 webmanager에서도 관리 가능. 자세한 내용: `docs/egress-netgate.md`의 "대역폭 제한" 절 |

## netgate → router 마이그레이션 — 완료

`.claude/functional-router-plan.md`에 확정된 설계에 따른 6단계 마이그레이션(골격
이전 → tailscale → Dev Proxy+tinyauth → code-docker 컷오버 → webmanager 통합 → 문서)이
전부 완료됨. 남은 건 이 마이그레이션 자체가 아니라 그 결과로 명확해진 후속 작업들:

1. **router-frontend에 Tailscale UI 추가** — 완료. `router/backend/internal/tailscale`에
   webmanager가 쓰던 것과 같은 config.go(YAML load/save, ConfigPath를
   `/var/lib/code-docker-router/tailscale/config.yaml`로 고정)/login.go(`tailscale up`
   detached 실행, binpath override는 제거하고 state.go와 같이 PATH의 `tailscale` 사용)/
   status.go(`tailscale status --json` 파싱)를 새로 포팅, `router/backend/internal/supervisor`
   (webmanager 것 그대로, 같은 `/run/supervisor.sock`)도 함께 이식. `handlers_tailscale.go`가
   GET/PUT `/api/tailscale/config`, GET/POST/DELETE `/api/tailscale/forwards[/{name}]`,
   GET/POST/DELETE `/api/tailscale/publish[/{name}]`, GET `/api/tailscale/status`,
   POST `/api/tailscale/login/{start,cancel}`를 등록 — mutation마다 해당 supervisord
   프로그램(`tailscale-forward`/`tailscale-publish`)을 재시작. `router/frontend/src/api/client.ts`를
   `createApiClient(prefix)` 팩토리로 일반화해서(Dev Proxy는 기존 `/dev-proxy` 그대로,
   Tailscale은 `/tailscale` 바인딩) `Tailscale`/`Status`/`GlobalSettings`/`Forwards`/`Publish`
   컴포넌트를 webmanager 옛 코드에서 포팅, webmanager `App.tsx`에 새 탭으로 연결. sshd(22)
   자동 노출 경고 문구는 tailscaled가 이제 router에만 있고 code-docker엔 없다는 현재
   아키텍처에 맞게 다시 씀(예전 문구는 tailscaled가 code-docker 안에 있던 시절 얘기라 더 이상
   맞지 않았음).
2. **router-manager 자체 admin API 인증** — 완료. `router/backend/internal/authgate`
   (webmanager의 것과 같은 argon2id + HMAC-signed 쿠키 설계지만, 별도 프로세스/바이너리라
   재사용이 안 돼서 새로 작성 — 단일 TTL·쿠키 Domain 없음으로 단순화, router-manager는
   항상 code-docker 쪽 nginx와 같은 origin으로만 도달하므로) — `ROUTER_MANAGER_AUTH_PASSWORD_HASH`
   (기본 꺼짐, opt-in)로 설정하면 모든 mutating 라우트(tailscale config PUT/forwards·
   publish·login의 POST·DELETE, dev-proxy expose의 POST·PUT·DELETE)가 잠기고, read 라우트
   (state/config GET/list/status)는 계속 열려 있음 — webmanager의 reads-open/writes-gated
   관례 그대로. `router-manager --hash-password` CLI로 해시 생성(webmanager의 동명 CLI와
   동일 패턴). `GET /api/auth/status` + `POST /api/auth/unlock`을 새 nginx `/router-auth/`
   위치로 노출. 프론트엔드: `router/frontend`의 `createApiClient`가 401을 받으면
   프롬프터를 호출해 재시도하는 인터셉터를 갖게 됨(webmanager 자체 client.ts와 같은
   패턴, 여러 prefix가 같은 게이트를 공유하도록 일반화), `RouterUnlockModalHost`를
   webmanager `App.tsx`에서 기존 `UnlockModalHost` 옆에 항상 마운트(Dev Proxy/Tailscale
   탭은 조건부 마운트라 401이 어느 탭에서 나든 뜨게 하려면 앱 루트에 둬야 함) — tinyauth와는
   완전히 별개(tinyauth는 개별 Dev Proxy expose의 최종 사용자 인증, 이건 router-manager
   자신의 admin API 보호).

실제 tailscale 로그인(authUrl 접속) 및 forwards:/publish: 실사용 트래픽 검증, tinyauth
실제 로그인 성공 경로(거부 경로만 검증됨)는 사용자의 직접 인터랙션이 필요해 아직 안 됨.

## 다음 후보 (설계만 완료, 미구현)

`router/.claude/net-auth-expansion-plan.md`의 6번 나머지(1번, tinyauth 탭
분리는 구현 완료) — 유저/그룹 ACL + OIDC provider 테스트 지원 + well-known
노출 + email 필드. 로컬 유저만 쓰는 지금 배포엔 "그룹" 개념 자체가 없음
(LDAP/OIDC 없이는 원천 불가)이 확인돼 있어, 실제 필요(예: Authentik
테스트)가 생기기 전까진 보류 결정(2026-08-09).

## 참고 문서

- `.claude/net-auth-expansion-plan.md` — Net 관리 탭/탭 URL 경로/tinyauth 비밀번호
  변경/DNS 빌트인 블록리스트 opt-out/router 자신의 사이드바(잠금 상태+테마 토글
  포함)/tinyauth 탭 분리/DNS dig 도구(+ALL 옵션) 전부 구현 완료, 6번 나머지만
  보류
- `.claude/functional-router-plan.md` — 전체 비전/결정 사항
- `.claude/router-dns-plan.md` — DNS 포워딩 + squid→dnsmasq 블록리스트 교체 설계
- `.claude/router-nginx-hardening-plan.md` — router 자체 nginx + 소켓화 + Dev Proxy
  target 검증 + router-manager 인증 강제 설계(진행 중, 보안 감사 발견 사항이 계기)
- `.claude/archive/tailscale-design.md` — code-docker 안에서 tailscale을 돌리던 시절의
  원래 설계(이 컨테이너의 tailscale 기능으로 완전히 대체됨, 역사 기록용)
- `.claude/backlog/egress-netgate-plan.md` (레포 루트) — netgate 기능의 원 설계, code-docker/dind
  쪽 netinit 루프도 다루는 문서라 레포 루트에 남음
- `docs/egress-netgate.md` (레포 루트) — 사용자 대상 문서
