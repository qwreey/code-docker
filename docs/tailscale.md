# tailscale 연결

tailscale(데몬+로그인+포트 가져오기/내보내기)은 code-docker가 아니라 **router**
컨테이너에서 실행됩니다 — code-docker보다 신뢰 수준이 높은 국경 컨테이너에 네트워크
관련 기능을 모으는 설계입니다
([`router/.claude/functional-router-plan.md`](../router/.claude/functional-router-plan.md)
참고). code-docker 자신은 tailscale 프로세스를 하나도 갖고 있지 않습니다.

**자세한 내용, 설정 방법, forwards/publish, 보안은 모두 [router.md](router.md#tailscale)로
옮겼습니다.**

code-docker 쪽에 남아있는 것은 로그인 필요 시 code-server 화면에 뜨는 배너뿐입니다 —
`config/code/code-patch/tailscale-notify.default.js`가 router의 읽기전용 상태 API를
(router 자신의 nginx가 `/router/` 경로로 host:80에서 직접 종단) 4초마다 폴링합니다.
배너 자체의 Ignore/알림 동작은 이전과 동일합니다.
