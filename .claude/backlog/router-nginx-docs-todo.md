# router 자체 nginx 도입 이후 문서 개정 체크리스트

`router/.claude/router-nginx-hardening-plan.md`의 구현이 끝난 뒤, 아래 문서들이
설명하는 포트 토폴로지/인증 모델이 stale해진다. 구현 커밋과 별도로, 나중에 한
라운드로 정리할 것 (사용자 판단: "바꿀 부분이 한둘이 아니니 나중에 큐잉").

- [ ] `docs/router.md` — "forwards / publish" 절 등에 남은 `code-docker:80`
  DNAT 경유 설명, router-manager `:8091` 직접 언급, tinyauth/router-manager
  인증 절에 새 인앱 비밀번호 설정 플로우(`POST /api/auth/setup`/`change`) 반영.
- [ ] `docs/dev-proxy.md` — "바깥 리버스 프록시 연결하기"의 "기본: nginx의
  `/exports/`를 경유" 절이 이제 router 자신의 nginx를 가리키도록(더 이상
  code-docker의 nginx가 아님), target이 기본 `code-docker`/`dind`로 제한된다는
  점과 `DEVPROXY_ALLOW_EXTERNAL_TARGETS` env var 추가.
- [ ] `docs/egress-netgate.md` — "호스트:80 → code-docker-router(PREROUTING
  DNAT) → code-docker:80(nginx)" 데이터 경로 설명이 더 이상 사실이 아님(router
  자신의 nginx가 80을 직접 받음) — 아키텍처 다이어그램/forwards 섹션 갱신.
- [ ] `example-env` — `ROUTER_MANAGER_ADDR`(TCP escape hatch),
  `ROUTER_NGINX_DENY_INTERNAL_EXPORTS`, `DEVPROXY_ALLOW_EXTERNAL_TARGETS` 등
  새 env var 문서화. `ROUTER_MANAGER_AUTH_PASSWORD_HASH` 코멘트를 "이제
  선택사항, 기본은 인앱 설정"으로 갱신.
- [ ] 루트 `CLAUDE.md`의 "router" 절 — nginx 서브시스템 추가, router-manager
  바인딩이 유닉스 소켓으로 바뀐 점, 인증 모델 변경.
- [ ] `router/plan.md` — "구현 완료" 표에 이번 작업 한 줄 추가(design doc은
  이미 "참고 문서"에 링크됨).
