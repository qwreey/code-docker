# webmanager 계획 (현재 상태 — 짧게 유지)

code-docker 내부 상태(tailscale, mise, supervisord, dind, sshd, git, 프로세스/포트)를
웹 UI 하나에서 들여다보고 조작할 수 있게 하는 관리자 패널. **이 문서는 지금 상태와
남은 할 일의 색인만** 담는다 — 기능별 자세한 설계/이유/이력은
`webmanager/.claude/`의 개별 문서에 있음(아래 "구현 완료"/"할 일" 표에서 링크).
매번 전부 읽을 필요 없이, 지금 건드릴 기능의 문서만 열어보면 됨.

## 왜 필요한가

기존엔 각 기능이 파일 편집 + `docker compose build`/`restart`/`forward-reload` 조합으로
관리됐다 (override 패턴, README 참고) — 전부 SSH/터미널 접근이 있다는 전제로 설계되어
있었는데, 브라우저 하나로 상태를 보고 웬만한 조작을 끝낼 수 있게 하는 게 목표.

## 아키텍처

스택/배포/인증 등 전체에 걸치는 결정은 `webmanager/.claude/architecture-plan-done.md`.
요약: Go(stdlib) + Vite/React(TS, CSR), 기존 이미지에 supervisord program으로 추가,
인증은 forward-auth 전적 위임(자체 로그인 없음), 바인드 주소는 아직 미정(`0.0.0.0:81`).

## 구현 완료

| 기능 | 문서 |
|---|---|
| Supervisor 프로세스 관리 | `.claude/supervisor-plan-done.md` |
| SSH authorized_keys 관리 | `.claude/sshkeys-plan-done.md` |
| Git 설정(user/email, 커밋 사이닝, SSH 호스트, HTTPS credential) | `.claude/gitconfig-plan-done.md` |
| Tailscale forwards/publish CRUD | `.claude/tailscale-plan-done.md` |
| vector 로그 파이프라인 + Logs 페이지 | `.claude/vector-logs-plan-done.md` |
| 프로세스/포트 뷰어 + 컨테이너 리소스 추적(btop 대체) | `.claude/processes-plan-done.md` |

전체 구현은 backend(Go)/frontend(React) subagent를 병렬로 여러 라운드 돌려서 진행,
각 라운드 사이 API 계약 불일치를 직접 대조해서 잡는 패턴 반복 — 새 기능도 이 방식
유지 권장(자세히는 `architecture-plan-done.md`).

**실제 컨테이너 검증**: 2026-08-02, `docker compose build && up`으로 전체 통합 확인
완료 (7개 supervisord program 전부 RUNNING, `docker compose logs` 라벨링 정상,
`/api/*` 전 엔드포인트 실응답 확인). 이후 `webmanager/review.md` 리뷰 라운드에서
나온 버그(critical 2건 포함)도 전부 수정 후 재검증 완료.

## 할 일 (우선순위 순, 문서 있으면 링크)

1. **Docker/dind 관리** — 미착수. `.claude/dind-plan.md`
2. **웹쉘(PTY)** — 미착수. `.claude/terminal-plan.md`
3. **Caddy 기반 dev 서버 expose** — 설계 완료, 미착수. `.claude/caddy-plan.md`
4. **Claude Code 상태/관리 탭** — 설계+마일스톤 확정, **M1(퀵 오버뷰)은 구현 착수
   가능**. `.claude/claude-plan.md`
5. **code-server 익스텐션 추천/설치** — 우선순위 중간, mise 안 기다려도 됨.
   `.claude/extensions-plan.md`
6. **mise 관리** — **최후순위**(범위가 넓어서 별도 설계 필요). `.claude/mise-plan.md`
7. code-server 설정(settings.json 등) 편집 UI — 후순위, 타당성 재검토 필요(`ideas.md`)
8. tailscale 로그인 상태/URL을 webmanager UI에도 노출 — 아이디어 단계, 문서 없음
9. 바인드 주소 전략 확정 — **최후순위**
10. `/code/.vector/logs/*.jsonl` 보존기간(retention) 정책 없음 — 알려진 갭
    (`review.md` 참고), 문서 없음

## 참고 문서

- **API 정확한 스펙**: `webmanager/backend/README.md`, `webmanager/frontend/README.md`
  (구현된 그대로 최신 유지되는 원본)
- **기능별 설계/이력**: `webmanager/.claude/` (README로 인덱스)
- **아이디어 백로그**(아직 계획 문서 없는 브레인스토밍): `webmanager/ideas.md`
- **프로젝트 리뷰**: `webmanager/review.md`
