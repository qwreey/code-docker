# router 계획 (현재 상태 — 짧게 유지)

code-docker의 네트워크 경계를 전담하는 컨테이너. **이 문서는 지금 상태와 남은 할 일의
색인만** 담는다 — 전체 비전/설계 결정은 레포 루트 `.claude/backlog/functional-router-plan.md`
(왜 router가 필요한지, 무엇이 이관되는지)와 `.claude/backlog/egress-netgate-plan.md`
(현재 이관된 egress/DNAT 기능의 원래 설계)에 있음. `webmanager/plan.md`와 같은 패턴 —
기능별 자세한 문서는 `router/.claude/`에 쌓일 예정(아직 없음, 필요해지면 생성).

## 왜 필요한가

`code-docker-netgate`(iptables 아웃바운드 필터링 + squid 콘텐츠 블록리스트 + 인바운드
DNAT)가 이미 code-docker-internal/external 양쪽에 다리를 걸친, code-docker보다 신뢰
수준이 높은 유일한 국경 통과 지점이었다. tailscale(데몬+forward+publish), Dev
Proxy(Caddy), 새 tinyauth 게이트까지 이 지점으로 모으면 신뢰 경계가 더 명확해지고
code-docker 쪽 네트워크 관련 코드/설정이 줄어든다 — 자세한 트레이드오프는
`functional-router-plan.md` 참고.

## 아키텍처

Go 없음/Node 없음, 순수 supervisord + 셸스크립트로 시작(오늘의 netgate 그대로). 이후
단계에서 "router-manager"라는 Go 백엔드(webmanager와 같은 패턴)와 React 프론트엔드가
추가될 예정 — 아직 없음. `router/config/netgate/`, `router/script/netgate-*.sh` 아래
"netgate"는 router 안의 한 기능 영역(egress/DNAT) 이름으로 유지 — 컨테이너 전체 이름은
`router`.

## 구현 완료

| 기능 | 상태 |
|---|---|
| netgate(iptables 아웃바운드 필터링, squid 블록리스트, 인바운드 DNAT) | `code-docker-netgate`에서 이 컨테이너로 순수 이전 완료 — 동작 변화 없음 |
| tailscale 전체(데몬+로그인+forwards+publish) + router-manager 백엔드(읽기전용 `GET /api/tailscale/state`) | 이식 완료. code-docker의 기존 tailscale은 Phase 4까지 병행 유지(원격 접근 단절 방지) — `forward` alias는 이미 이 컨테이너로 이동, `private`/bind-addr 기본값은 아직 code-docker 쪽(Phase 4에서 정리) |

## 할 일

`.claude/backlog/functional-router-plan.md`에 확정된 설계를 순서대로 구현 중 (실행
계획은 세션 내 plan 파일 참고, 완료되면 이 문서에 반영):

1. ~~tailscale 전체(데몬+로그인+forwards+publish) 이관, 읽기전용 상태 API~~ — 완료
2. Dev Proxy(Caddy) 이관 + tinyauth 신설
3. code-docker 쪽 대응 기능 제거, nginx `/tailscale` 라우트 배선
4. webmanager가 이 컨테이너의 페이지 컴포넌트를 import하도록 통합(router/frontend
   신설도 이 단계에서 — 지금은 소비자가 없어 미룸)

실제 tailscale 로그인(authUrl 접속) 및 forwards:/publish: 실사용 트래픽 검증은 사용자의
직접 인터랙션이 필요해 아직 안 됨 — `router-manager`가 `NeedsLogin` 상태와 `authUrl`을
정상 반환하는 것까지는 확인됨.

## 참고 문서

- `.claude/backlog/functional-router-plan.md` (레포 루트) — 전체 비전/결정 사항
- `.claude/backlog/egress-netgate-plan.md` (레포 루트) — netgate 기능의 원 설계
- `docs/egress-netgate.md` (레포 루트) — 사용자 대상 문서
