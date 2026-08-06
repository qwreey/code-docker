# router 계획 (현재 상태 — 짧게 유지)

code-docker의 네트워크 경계를 전담하는 컨테이너. **이 문서는 지금 상태와 남은 할 일의
색인만** 담는다 — 전체 비전/설계 결정은 레포 루트 `.claude/backlog/functional-router-plan.md`
(왜 router가 필요한지, 무엇이 이관되는지)와 `.claude/backlog/egress-netgate-plan.md`
(현재 이관된 egress/DNAT 기능의 원래 설계)에 있음. `webmanager/plan.md`와 같은 패턴 —
기능별 자세한 문서는 `router/.claude/`에 쌓일 예정(아직 없음, 필요해지면 생성).

## 왜 필요한가

`code-docker-netgate`(iptables 아웃바운드 필터링 + DNS 레벨 콘텐츠 블록리스트 + 인바운드
DNAT)가 이미 code-docker-internal/external 양쪽에 다리를 걸친, code-docker보다 신뢰
수준이 높은 유일한 국경 통과 지점이었다. tailscale(데몬+forward+publish), Dev
Proxy(Caddy), 새 tinyauth 게이트까지 이 지점으로 모으면 신뢰 경계가 더 명확해지고
code-docker 쪽 네트워크 관련 코드/설정이 줄어든다 — 자세한 트레이드오프는
`functional-router-plan.md` 참고.

## 아키텍처

`router-manager`라는 Go 백엔드(webmanager와 같은 패턴, `router/backend`)와
`@code-docker/router-frontend`라는 React 프론트엔드 패키지(`router/frontend`, 레포 루트
npm workspace의 일원 — webmanager/frontend가 이 패키지의 컴포넌트를 실제로 import해서
씀)가 있다. `router/config/netgate/`, `router/script/netgate-*.sh` 아래 "netgate"는
router 안의 한 기능 영역(egress/DNAT) 이름으로 유지 — 컨테이너 전체 이름은 `router`.

## 구현 완료

| 기능 | 상태 |
|---|---|
| netgate(iptables 아웃바운드 필터링, 인바운드 DNAT) | `code-docker-netgate`에서 이 컨테이너로 순수 이전 완료 — 동작 변화 없음 |
| DNS 포워딩(dnsmasq) — code-docker-internal이 `internal: true`라 Docker 내장 DNS가 외부 포워딩을 거부하는 문제 해결 | 구현 완료·커밋됨(`00bba1a`). 자세한 내용: `.claude/backlog/router-dns-plan.md` |
| squid 제거 + DNS 레벨 블록리스트(dnsmasq `addn-hosts`)로 교체 | 구현 완료. squid의 ssl-bump anti-spoofing이 CDN형 도메인(예: `registry-1.docker.io`)을 오탐해 `docker pull`을 깨뜨리는 버그가 계기 — 자세한 내용: `.claude/backlog/router-dns-plan.md`의 "2부" |
| tailscale 전체(데몬+로그인+forwards+publish) + router-manager 백엔드(읽기전용 `GET /api/tailscale/state`) | 이식 완료. code-docker의 기존 tailscale은 Phase 4까지 병행 유지(원격 접근 단절 방지) — `forward` alias는 이미 이 컨테이너로 이동, `private`/bind-addr 기본값은 아직 code-docker 쪽(Phase 4에서 정리) |
| Dev Proxy(Caddy) + tinyauth forward-auth | 이식 완료. `internal/devproxy`가 tinyauth를 타겟으로 렌더링하도록 변경(webmanager의 `/api/auth/verify` 대신), `code-docker-tinyauth` 서비스(공식 이미지, 소스 빌드 아님 — pnpm 프론트엔드 빌드가 필수라 dind-authz 패턴과 안 맞음) 신설. 실제 request → Caddy → tinyauth → 401+로그인 리다이렉트 체인까지 검증됨 |
| code-docker 컷오버 | 완료. code-docker에서 tailscale/caddy-adapter 완전 제거(프로세스 0개, 바이너리도 없음), nginx `/tailscale/`(router-manager readonly API)·`/exports/`(Dev Proxy) 라우트를 router로 배선, `tailscale-notify.default.js`가 새 엔드포인트를 폴링하도록 변경. 이제부터 code-docker는 tailscale/Dev Proxy에 대해 아무것도 모른다 |
| webmanager 통합 | 완료. `router/frontend` 신설(npm workspace), Dev Proxy 탭을 webmanager가 그 패키지에서 import — 실제 브라우저로 expose 생성까지 검증됨(라우팅 버그 하나 발견해서 즉시 수정: `/dev-proxy/` nginx 라우트가 빠져있었음). webmanager의 옛 Dev Proxy/Tailscale 백엔드·프론트엔드 코드 전부 삭제, DevAuth도 tinyauth로 대체되어 삭제 |
| 문서 정리 | 완료. `docs/router.md` 신설, `docs/tailscale.md`/`dev-proxy.md`/`egress-netgate.md`/`webmanager.md`/`webmanager-config.md`/`build-customization.md`/`index.md`/`tips/adb.md`와 레포 루트 `CLAUDE.md`를 새 구조에 맞게 갱신. 부수적으로 발견한 회귀도 하나 고침 — `bin/forward-reload`가 Phase 2 이후 조용히 깨져 있었음(code-docker 안에서 더 이상 존재하지 않는 supervisord 프로그램을 재시작하려 시도) |

## netgate → router 마이그레이션 — 완료

`.claude/backlog/functional-router-plan.md`에 확정된 설계에 따른 6단계 마이그레이션(골격
이전 → tailscale → Dev Proxy+tinyauth → code-docker 컷오버 → webmanager 통합 → 문서)이
전부 완료됨. 남은 건 이 마이그레이션 자체가 아니라 그 결과로 명확해진 후속 작업들:

1. **router-frontend에 Tailscale UI 추가** — 지금 router-manager 백엔드는
   `GET /api/tailscale/state`(읽기전용) 하나뿐이라, webmanager가 예전에 갖고 있던
   forwards/publish CRUD + 로그인 트리거 UI는 이번에 포팅하지 않고 통째로 뺐음(가짜로
   "이식 완료"라고 하지 않기 위한 의도적 선택 — 프론트만 옮기면 존재하지 않는 백엔드를
   호출하는 깨진 UI가 됨). 실제로 하려면 router-manager에 `internal/tailscale`
   패키지(webmanager가 쓰던 것과 비슷한 config/forwards/publish/login 관리)를 먼저
   새로 만들어야 함 — "파일 이동"이 아니라 "새 기능 구현"에 가까운 별도 작업.
2. **router-manager 자체 admin API 인증** — 지금 `/api/dev-proxy/*`, `/api/tailscale/*`는
   host 포트가 안 열려 있다는 것만 믿고 인증 없이 열려 있음(Phase 2/3와 동일 논리). UI가
   생겼으니 이제 tinyauth 등으로 이 API 자체를 보호할지 결정 필요.
3. **shared UI kit** — router/frontend가 webmanager의 공통 컴포넌트(ErrorBanner 등)를
   지금은 각자 따로 들고 있음(의도적 단순화, functional-router-plan.md 참고). 세 번째
   패키지 소비자가 생기면 그때 진짜 공유 패키지로 뽑는 걸 고려.

실제 tailscale 로그인(authUrl 접속) 및 forwards:/publish: 실사용 트래픽 검증, tinyauth
실제 로그인 성공 경로(거부 경로만 검증됨)는 사용자의 직접 인터랙션이 필요해 아직 안 됨.

## 참고 문서

- `.claude/backlog/functional-router-plan.md` (레포 루트) — 전체 비전/결정 사항
- `.claude/backlog/egress-netgate-plan.md` (레포 루트) — netgate 기능의 원 설계
- `.claude/backlog/router-dns-plan.md` (레포 루트) — DNS 포워딩 + squid→dnsmasq 블록리스트 교체 설계
- `docs/egress-netgate.md` (레포 루트) — 사용자 대상 문서
