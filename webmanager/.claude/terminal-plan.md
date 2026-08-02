# 웹쉘(터미널) (구현 전, 미착수)

`caddy-plan.md`에서 확정된 우선순위: dind 다음, caddy dev-proxy보다 먼저(전체 순서는
`webmanager/CLAUDE.md` 참고).

## 알려진 것

- xterm.js(프론트) + PTY(백엔드)로 여는 표준 패턴(ttyd/gotty/wetty와 동일 계열).
- code-server가 이미 통합 터미널을 제공하지만, webmanager 단독으로도 열리면
  code-server 없이도 최소한의 접근 수단이 됨(예: code-server 자체가 죽었을 때 복구용
  — 이게 이 기능의 핵심 존재 이유).

## API 초안 (구현 전 상상, 재검토 필요)

`WS /api/terminal` — `creack/pty`로 새 쉘 세션 생성, xterm.js와 WebSocket으로 연결.

## 구현 시 확인할 것

- 세션 라이프사이클(브라우저 탭 닫으면 PTY도 죽일지, 백그라운드에 유지할지 — 유지
  한다면 여러 세션을 어떻게 나열/재접속할지).
- 인증 관련: 이 기능이 "code-server 자체가 죽었을 때 복구용"이라는 존재 이유를
  가지므로, webmanager 자체가 다운되는 시나리오와 무관하게 항상 살아있어야 함(이미
  webmanager는 별도 supervisord program이라 code-server와 독립적으로 뜸 — 이 전제가
  실제로 맞는지 재확인).
- root 쉘을 브라우저에 그대로 여는 기능이라, webmanager의 기존 신뢰 모델(forward-auth
  only)에서 가장 강력한 권한을 주는 기능이 됨 — dind API와 동급이거나 그 이상의
  각주가 필요해 보임(구현 시 README/CLAUDE.md에 명시할 것).
