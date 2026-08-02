# webmanager/.claude/ — 기능별 계획 문서

webmanager만을 위한 계획/설계 문서 모음 (레포 전체에 걸치는 건 루트 `.claude/`).
파일 이름 규칙: **완료된 기능은 `-plan-done.md`, 아직 안 한 건 `-plan.md`**(접미사
없음)로 구분. `webmanager/plan.md`는 이 전체를 아우르는 짧은 현재 상태 요약 —
먼저 그걸 보고, 특정 기능의 자세한 내용/이유가 필요할 때만 아래 개별 문서를 열어볼 것.

**저장소 소유자가 답해야 할 질문이 있으면 `question.md`에 전부 모아둠** —
각 plan 문서에 흩어진 "사용자 확인 필요" 절의 취합본(이전 `attention-needed.md`를
흡수함). 구현을 막고 있진 않음(전부 합리적 기본값으로 진행 중), 시간 날 때
훑어보고 기본값이 마음에 안 드는 것만 답하면 됨.

**실사용 피드백 처리 기록은 `feedback-2026-08-02.md`** — 실제로 써보고 나온
개선 요청들을 어떻게 처리했는지(무엇을 구현했고, 무엇을 계획만 해뒀는지)
추적하는 문서. 다시 조사/구현하기 전에 먼저 확인할 것.

## 완료 (`*-plan-done.md`)

| 문서 | 기능 |
|---|---|
| `architecture-plan-done.md` | webmanager 전체 아키텍처(스택/인증/배포/개발 방식) — 특정 기능이 아니라 횡단 결정 |
| `supervisor-plan-done.md` | supervisord 프로세스 관리(목록/시작/정지/재시작/로그, 프로그램별 메타데이터로 특정 컨트롤 비활성화, PID 트리 펼침) |
| `sshkeys-plan-done.md` | SSH authorized_keys 관리 |
| `gitconfig-plan-done.md` | git user/email, 커밋 사이닝(SSH/GPG), 호스트별 SSH 키, HTTPS credential, git-lfs install, .gitconfig 원본 편집, known_hosts 관리 |
| `tailscale-plan-done.md` | tailscale forwards/publish 설정 CRUD (webmanager UI 쪽 — tailscaled 인프라 자체는 루트 `.claude/archive/tailscale-design.md`) |
| `vector-logs-plan-done.md` | vector 로그 파이프라인 도입 + webmanager Logs 페이지(시간범위 필터, 커서 페이지네이션, 실시간 누적, 비밀번호 게이트) |
| `processes-plan-done.md` | "작업 관리자" 탭(구 Processes) — 성능/프로세스 서브탭, 코어별 CPU 히트맵, 메모리 구성요소별 분해, 프로세스 트리+리스트, 필터/검색, 페이지네이션 |
| `extensions-plan-done.md` | code-server 확장 추천/설치 (카테고리별 그룹핑, 접기, 설치된 목록, 표시 토글) |
| `projects-plan-done.md` | 프로젝트 스캔/정리 1단계(용량/재생성 가능 폴더 탐지, 최근 편집 런처, mise 도구 표시, 읽기 전용 — 2단계 삭제는 미착수) |
| `mise-plan-done.md` | mise 관리(install/use/uninstall, 설치된 도구 목록, env 미리보기) + 설치 추천 목록(접기, 표시 토글) |
| `filemanager-plan-done.md` | 파일 관리자(업로드/다운로드/이동/복사/이름변경/멀티선택/텍스트편집/정보패널, 자체 비밀번호 게이트) |
| `authgate-plan-done.md` | 공용 비밀번호 게이트(`internal/authgate`) — 어떤 라우트가 게이트됐는지의 단일 소스 |
| `history-raw-done.md` | 위 문서들로 나누기 전, 라운드별 원본 의사결정 로그(참고용 백업, 왠만하면 위 개별 문서로 충분함) |

## 아직 안 함 (`*-plan.md`)

| 문서 | 기능 | 우선순위 |
|---|---|---|
| `dind-plan.md` | Docker/dind 관리 — **리서치 완료**(CLI shell-out, run/exec 범위 제외, 로그는 폴링), 구현은 미착수 | `webmanager/CLAUDE.md` 순서 참고 |
| `terminal-plan.md` | 웹쉘 — **M1(임시 세션)+비밀번호 게이트+모바일 컨트롤/키바인딩/테마 구현 완료**, M2(named 영속 세션)부터 미착수 | M2는 바로 가능 |
| `extension-search-plan.md` | 익스텐션 검색/마켓플레이스 URL 붙여넣기 설치 | M4 언저리, 급하지 않음 |
| `theme-toggle-plan.md` | Light/Dark 수동 토글 + 사이드바 상태 바 | 급하지 않음 |
| `caddy-plan.md` | dev 서버를 와일드카드 서브도메인으로 자동 expose (Caddy 인스턴스) | dind/터미널보다도 낮음 |
| `claude-plan.md` | Claude Code 상태/관리 탭 — **M1~M3 구현 완료**, M4(익스텐션 배너)부터 미착수 | M4는 바로 가능 |
| `guide-plan.md` | code-docker 도움말/가이드를 webmanager에 임베드 — 아이디어 단계, 구현 안 함 | 미정(사용자 검토 대기) |
| `version-panel-plan.md` | code-server/mise 버전 관리 패널 — 아이디어 단계, 구현 안 함 | 최하(guide-plan과 동급) |
| `session-viewer-plan.md` | 활성 세션 목록 보기 — 아이디어 단계, "세션"의 정의부터 불명확해서 착수 시 사용자와 인터랙티브 확인 필수 | 최하 |

전체 순서/우선순위는 `webmanager/CLAUDE.md`가 최종 소스 — 위 표의 "우선순위" 칸은
힌트일 뿐 그쪽이 바뀌면 이 표도 갱신할 것.
