# webmanager/.claude/ — 기능별 계획 문서

webmanager만을 위한 계획/설계 문서 모음 (레포 전체에 걸치는 건 루트 `.claude/`).
파일 이름 규칙: **완료된 기능은 `-plan-done.md`, 아직 안 한 건 `-plan.md`**(접미사
없음)로 구분. `webmanager/plan.md`는 이 전체를 아우르는 짧은 현재 상태 요약 —
먼저 그걸 보고, 특정 기능의 자세한 내용/이유가 필요할 때만 아래 개별 문서를 열어볼 것.

## 완료 (`*-plan-done.md`)

| 문서 | 기능 |
|---|---|
| `architecture-plan-done.md` | webmanager 전체 아키텍처(스택/인증/배포/개발 방식) — 특정 기능이 아니라 횡단 결정 |
| `supervisor-plan-done.md` | supervisord 프로세스 관리(목록/시작/정지/재시작/로그) |
| `sshkeys-plan-done.md` | SSH authorized_keys 관리 |
| `gitconfig-plan-done.md` | git user/email, 커밋 사이닝(SSH/GPG), 호스트별 SSH 키, HTTPS credential |
| `tailscale-plan-done.md` | tailscale forwards/publish 설정 CRUD (webmanager UI 쪽 — tailscaled 인프라 자체는 루트 `.claude/archive/tailscale-design.md`) |
| `vector-logs-plan-done.md` | vector 로그 파이프라인 도입 + webmanager Logs 페이지 |
| `processes-plan-done.md` | 프로세스/포트 뷰어(btop 대체) + 컨테이너 cpu/mem/disk 추적 |
| `history-raw-done.md` | 위 문서들로 나누기 전, 라운드별 원본 의사결정 로그(참고용 백업, 왠만하면 위 개별 문서로 충분함) |

## 아직 안 함 (`*-plan.md`)

| 문서 | 기능 | 우선순위 |
|---|---|---|
| `dind-plan.md` | Docker/dind 관리 | `webmanager/CLAUDE.md` 순서 참고 |
| `terminal-plan.md` | 웹쉘(PTY) | 〃 |
| `caddy-plan.md` | dev 서버를 와일드카드 서브도메인으로 자동 expose (Caddy 인스턴스) | 〃 |
| `mise-plan.md` | mise 도구 관리 + 설치 추천 목록 | 최후순위 |
| `extensions-plan.md` | code-server 확장 추천/설치 (mise와 독립적, 우선순위 중간) | 중간 |
| `claude-plan.md` | Claude Code 상태/관리 탭 — **M1(퀵 오버뷰)은 구현 착수 가능** | M1은 바로 가능 |

전체 순서/우선순위는 `webmanager/CLAUDE.md`가 최종 소스 — 위 표의 "우선순위" 칸은
힌트일 뿐 그쪽이 바뀌면 이 표도 갱신할 것.
