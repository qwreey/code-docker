# router 자체 nginx 도입 이후 문서 개정 체크리스트

`router/.claude/router-nginx-hardening-plan.md`의 구현이 끝난 뒤, 아래 문서들이
설명하는 포트 토폴로지/인증 모델이 stale해진다. 구현 커밋과 별도로, 나중에 한
라운드로 정리할 것 (사용자 판단: "바꿀 부분이 한둘이 아니니 나중에 큐잉").

- [x] `docs/router.md` — done (2026-08-07 follow-up pass): router-manager
  intro no longer claims code-docker's nginx proxies `/tailscale/`·
  `/dev-proxy/`·`/router-auth/`, now describes router's own nginx terminating
  host:80 and proxying everything through the unified `/router/` unix-socket
  location; tailscale login-banner polling URL updated to
  `/router/api/tailscale/state`. (The in-app `POST /api/auth/setup`/`change`
  flow this item also called out was already reflected before this pass.)
- [x] `docs/dev-proxy.md` — done (2026-08-07 follow-up pass): "기본: nginx의
  `/exports/`를 경유" section rewritten to describe router's own nginx (not
  code-docker's) terminating host:80 directly; target field now documents
  the default `code-docker`/`dind`-only allowlist and
  `DEVPROXY_ALLOW_EXTERNAL_TARGETS`.
- [x] `docs/egress-netgate.md` — already done by the time this pass started
  (found already describing router's own nginx terminating host:80 directly,
  no more PREROUTING DNAT-to-code-docker claim).
- [ ] `example-env` — still pending: `ROUTER_MANAGER_ADDR`(TCP escape hatch),
  `ROUTER_NGINX_DENY_INTERNAL_EXPORTS`, `DEVPROXY_ALLOW_EXTERNAL_TARGETS` 등
  새 env var 문서화. `ROUTER_MANAGER_AUTH_PASSWORD_HASH` 코멘트를 "이제
  선택사항, 기본은 인앱 설정"으로 갱신.
- [ ] 루트 `CLAUDE.md`의 "router" 절 — still pending: nginx 서브시스템 추가,
  router-manager 바인딩이 유닉스 소켓으로 바뀐 점, 인증 모델 변경.
- [x] `router/plan.md` — already done by the time this pass started (the
  "구현 완료" table already has the nginx/socket/target-validation/in-app-auth
  row, first row of the table).
