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

스택/배포/인증 등 전체에 걸치는 결정은 `webmanager/.claude/base/architecture.md`.
요약: Go(stdlib) + Vite/React(TS, CSR), 기존 이미지에 supervisord program으로 추가,
인증은 forward-auth 전적 위임(자체 로그인 없음), 바인드 주소는 `private:81`(레포 루트
`docker-compose.yml`의 `private` alias 주석 참고 — 원래 code-docker 자신의
tailscaled가 쓰던 tailnet 자동노출 회피 이유였지만, code-docker는 이제 tailscaled를
아예 실행하지 않아 이 근거 자체는 없어짐 — 그냥 기존 기본값을 바꿀 이유가 없어서
유지 중).

## 구현 완료

| 기능 | 문서 |
|---|---|
| Supervisor 프로세스 관리 | `.claude/archive/supervisor-plan-done.md` |
| SSH authorized_keys 관리 | `.claude/qa-request/sshkeys-plan-done.md` |
| Git 설정(user/email, 커밋 사이닝, SSH 호스트, HTTPS credential, git-lfs install, .gitconfig 원본 편집) | `.claude/qa-request/gitconfig-plan-done.md` |
| Tailscale forwards/publish CRUD + 상태 조회(로그인 필요 시 배너, 내 정보/피어 목록, `GET /api/tailscale/status`) — webmanager가 직접 구현했던 시절의 기록. 이후 이 기능 자체가 router로 완전히 이관되어 webmanager 쪽 백엔드/프론트엔드 코드는 삭제됨 — 지금은 `router/frontend`의 컴포넌트를 webmanager가 그대로 가져와 쓰고, router-manager API를 호출한다(`docs/router.md#tailscale` 참고) | `.claude/archive/tailscale-plan-done.md` |
| vector 로그 파이프라인 + Logs 페이지 | `.claude/archive/vector-logs-plan-done.md` |
| 작업 관리자(구 "Processes") — 성능/프로세스 서브탭 분리, 프로세스 트리+리스트, 필터/검색, 코어별 CPU 히트맵(호버 시 최근 히스토리 스파크라인 포함), 메모리 구성요소별 분해(호스트 물리 vs cgroup), 컨테이너 자체 루트 파일시스템의 최상위 디렉토리별 디스크 사용량 분석(Storage Sense류, `du` 기반, 캐시 + 수동 새로고침 전용) | `.claude/archive/processes-plan-done.md` |
| Docker/dind 관리 M1(읽기 전용 — 컨테이너/이미지 목록, 로그 조회, `internal/dind` CLI 셸아웃)+M2(start/stop/remove, 확인 다이얼로그 필수, 비밀번호 게이트)+M3(docker inspect 상세 뷰, 비밀번호 게이트 — Config.Env 평문 노출 우려로 list/logs와 달리 게이트) | `.claude/qa-request/dind-plan-done.md` |
| Claude Code 상태 탭 M1(퀵 오버뷰)+M2(히트맵/주간그래프/모델별 토큰)+M3(Skills/Plugins) + 설치 버튼(mise 재사용)/mise 버전 확인·업데이트/버전 확인 무시 체크박스(백엔드 영속)/브라우저 내 로그인 자동화(`claude auth login` 서브프로세스 프록시, 파이프만으로 충분함을 실측 확인 — PTY 불필요) | `.claude/archive/claude-plan-done.md` (남은 M4~M5는 `.claude/claude-rework-v2.md`로 분리) |
| code-server 익스텐션 추천/설치 (카테고리별 그룹핑, open-vsx "더 보기" 링크, 삭제(uninstall) 포함) | `.claude/archive/extensions-plan-done.md` |
| 프로젝트 스캔/정리 1단계(용량/재생성 가능 폴더 탐지, 최근 편집 런처, mise 도구 표시)+2단계(재생성 가능 폴더 단위 삭제, 확인 다이얼로그 필수, 비밀번호 게이트) | `.claude/archive/projects-plan-done.md` |
| mise 관리(install/use/uninstall, 설치된 도구 목록, env 미리보기, 추천 목록, 설정에서만 제거하고 바이너리는 유지하는 비활성화/재활성화 토글) + 도구 검색(`mise registry --json`)/원격 버전 선택(`mise ls-remote --json`) 후 설치, mise 탭 모든 job 액션을 top-level 다이얼로그로 통일 | `.claude/archive/mise-plan-done.md` (도구 검색+버전 선택은 `.claude/archive/mise-search-plan-done.md`) |
| 웹쉘(터미널) M1(임시 세션, xterm.js+PTY/WebSocket, 비밀번호 게이트 소급 적용됨) + M2(named 영속 세션, `internal/termsession`, 탭 UI/유지 토글/유휴 자동정리) + 모바일 레이아웃 재설계(키보드 추적, 엣지투엣지, 테마 동화 색상) | `.claude/archive/terminal-plan-done.md` |
| 터미널 홈 탭(항상 열려있는 첫 탭 — 세션 목록 전환 + 시작 위치/실행 명령을 저장하는 프로파일 CRUD, 세션 생성 시 cwd/초기 명령 지원하도록 `internal/termsession` 확장, 데스크탑 가로 분할/카드형 목록/드래그앤드롭 정렬) | `.claude/archive/terminal-home-plan-done.md` |
| 공용 비밀번호 게이트(`internal/authgate`, argon2id + ENV 전용 저장, 읽기 열림/쓰기 게이트 원칙으로 Git/SSH/Tailscale/Supervisor/Logs까지 확장, 터미널도 `RequiresUnlock`으로 완전히 감싸짐) — Tailscale 부분은 당시 기록이고, 이후 Tailscale이 router로 이관되며 이 게이트 대상에서는 빠졌다(router-manager 자신의 별도 `internal/authgate` 인스턴스가 대신 담당, `docs/router.md#router-manager-자체-인증` 참고) | `.claude/archive/authgate-plan-done.md` |
| 파일 매니저(업로드/다운로드/이동/복사/이름변경/폴더생성/멀티선택/정보패널/텍스트편집, 자체 비밀번호 게이트) | `.claude/archive/filemanager-plan-done.md` (업로드 진행률/chmod/zip 다운로드 등 v1 잔여 항목은 `.claude/research/filemanager-rework-plan.md`) |
| 공용 코드 에디터(CodeMirror 6, 지연 로딩) — git raw 설정 편집/파일 매니저가 재사용 | 별도 문서 없음(공용 컴포넌트, `src/components/common/CodeEditor.tsx`) |
| Supervisor 로그 다이얼로그/바텀시트, 반응형 레이아웃(모바일 햄버거 사이드바), 로그 페이지네이션/시간범위 필터, CPU/메모리/디스크/네트워크 사용량 히스토리 그래프, 사이드바 드래그앤드롭 순서 변경(서버에 저장, `GET/PUT /api/ui/sidebar-order`), 탭 이름 영어로 통일(Code Extensions/Projects/Task Manager/Files) | 문서 없음(UI/관측성 개선, 각 기능 자체는 위 표의 해당 기능 문서 소관) |
| `docker-compose.yml`에 모든 `WEBMANAGER_*` env var를 주석 처리된 상태로 문서화(값 예시는 안 채움, 필요할 때 주석 해제), locale(`LANG`)도 TZ 옆에 주석으로 추가 | 문서 없음(레포 루트 `docker-compose.yml` 자체가 최신 소스) |
| Light/Dark 수동 토글(3-way: 자동/라이트/다크, `data-theme` 속성 + `localStorage`) + 사이드바 하단 잠금 상태 표시/미리 해제 + `index.css` 컬러 시스템 중앙화(기본 UI 다크 값 신규 설계 포함 — 원래 전혀 없었음, dataviz 스킬로 차트 팔레트 재검증) | `.claude/archive/theme-toggle-plan-done.md` |
| `.env.webmanager` 마이그레이션 도구(`webmanager --env-migrate` — 키 추가/삭제 반영(삭제된 키는 `#~` 아카이브 섹션으로), 유저 코멘트 보존, `#!important`/`#!` 마커로 조직 강제값·권장값-변경-충돌 표시, 경로 기반 템플릿(조직 커스텀 마운트 가능) + 기동 로그/웹 UI 경고 배너(백업 안내 + 명령어 인라인 코드 표기, dismiss 영속화)) | `.claude/archive/env-migration-plan-done.md` |
| code-server(`/`)+webmanager(`/manager`)를 컨테이너 안 nginx로 단일 origin 통합 — code-server/webmanager 내부 포트 이동, `code-config.yaml` 매 시작 재생성, 프론트엔드 서브패스(`apiUrl()`/`BASE_URL`) 대응까지 전부 구현 | `.claude/archive/expose-plan-done.md` |
| 바인드 주소 전략 확정(구 TODO 5번) — code-server/webmanager를 loopback(`127.0.0.1`) 대신 전용 tailscale IP(`private` 호스트네임)에 바인드, nginx `listen 127.0.0.1:80`으로 tailscale 자동 loopback 포워딩 경로 차단, `ALLOWED_HOSTS`(nginx Host 헤더 화이트리스트) 추가 | 레포 루트 `docs/router.md`의 "보안" 절 (당시엔 `docs/tailscale.md`에 있었으나, tailscale이 router로 이관되며 그쪽으로 옮겨짐 — 전용 webmanager 문서는 없음, nginx/code-server/docker-compose.yml 전체에 걸친 변경이라 레포 루트 문서가 소관) |
| mise 전역 설치/삭제 성공 후 code-server 재시작을 눌러서 바로 실행 가능(`POST /api/supervisor/processes/code-server/restart` 재사용, `frontend/src/utils/restartCodeServer.ts`) — 정적 안내문에서 버튼으로 승격, 잡 진행 패널(`Mise/JobPanel.tsx`)을 Mise 탭/Claude 탭이 공유하도록 추출 | 문서 없음(작은 갭 메우기, 별도 계획 문서 없이 진행) |
| Claude 탭 안 대화 로그 뷰어 v1 — 프로젝트 전체의 세션 트랜스크립트 목록/축약 채팅뷰(`CLAUDE_CONFIG_DIR/projects/*/*.jsonl`), 백엔드는 목록+원본 라인 페이지네이션만 제공하고 파싱은 프론트가 벤더링한 Zod 스키마(`d-kimuson/claude-code-viewer` MIT)로 처리, Terminal/Files/Logs와 동급으로 비밀번호 게이트 | `.claude/archive/claude-session-log-plan-done.md` |
| Dev Proxy 탭 — 내부 Caddy 인스턴스(`caddy-adapter` supervisord program)로 dev 서버를 와일드카드 서브도메인에 노출, `internal/devproxy`(Caddyfile 조각 CRUD, `caddy adapt` 검증 후 `caddy reload`), 인증은 `internal/authgate`를 Caddy `forward_auth`에 연결(`GET /api/auth/verify`, 독립 로그인 페이지 `/manager/dev-auth`) — webmanager가 직접 구현했던 시절의 기록. 이후 Caddy/Dev Proxy 전체가 router로 완전히 이관되어 webmanager 쪽 `internal/devproxy`/`caddy-adapter`/이 `forward_auth` 연동은 전부 삭제됨, 인증도 tinyauth로 대체됨(`docs/dev-proxy.md#인증` 참고) — 지금은 `router/frontend`의 컴포넌트를 webmanager가 그대로 가져와 쓰고, router-manager API를 호출한다 | `.claude/qa-request/caddy-plan-done.md`(원래 "인증은 바깥에 위임" 결정이 뒤집힘 — 문서 상단에 갱신됨) |
| 프로젝트별 git 상태 패널(신규, `internal/projectgit`) — staged/changed/untracked/behind/ahead/diverged/stashed/conflicts 요약(파싱 로직은 `~/.config/fish/functions/quiteline-fish/_qtm_git_info.fish`의 `git status --porcelain -b` 분류 규칙을 그대로 이식), 커밋 로그(커서 페이지네이션)/커밋별 diff/미변경·스테이지 diff(직접 만든 +/- 라인 색칠, 새 의존성 없음)/리모트/브랜치/태그 조회. 읽기 전용만 구현(스테이징/커밋/push·pull/merge·rebase 도구는 다음 마일스톤으로 보류), 모든 엔드포인트는 프로젝트 경로를 알려진 프로젝트 목록과 정확히 일치시켜 검증한 뒤에만 `git` 셸아웃, 전부 읽기라 게이트 없음. 프론트는 `components/common/Git/`에 프로젝트 경로 하나만 받는 형태로 위치 — 파일매니저 리워크 등 다른 곳에서도 재사용 가능하게 의도적으로 분리 | `.claude/qa-request/project-git-status-plan-done.md` |
| 열린 세션(어느 브라우저 탭이 어느 폴더를 열어놨는지) — 클라이언트가 UUID를 자체 발급해 30초마다 heartbeat를 보내는 방식, 새 사이드바 탭("열린 세션") | `.claude/archive/session-heartbeat-plan-done.md` |
| code-server PWA manifest에 `shortcuts` 필드 주입("Open manager" 점프리스트 항목) — nginx가 `/manifest.json`만 webmanager로 가로채 원본을 fetch+편집, 실패 시 code-server 원본으로 자동 폴백 | `.claude/archive/manifest-shortcuts-plan-done.md` |
| 전방위 QA 라운드 — 공용 `ConfirmDialog` 컴포넌트화(기존 `Sheet`와 함께 다이얼로그 표준화, `KillConfirmDialog`/`DeleteReclaimableDialog`가 이걸 감싸는 얇은 래퍼로 정리, 터미널 프로파일 삭제의 남은 `window.confirm` 홀드아웃도 정리); Claude Code 설치 오버레이가 `position: fixed`로 사이드바까지 덮어 못 빠져나가던 버그 수정(탭 콘텐츠에만 스코프) + 설치 완료 후 로그를 볼 수 있게 자동전환 대신 "다시 로드" 버튼 + 설치 job id를 localStorage에 영속화(탭 이동 후 복귀해도 진행 이어봄) + 로그인 링크를 버튼화(Tailscale 탭과 동일 패턴); mise/익스텐션 재시작 필요 플래그를 백엔드에 영속화(`internal/restartstatus`, 설치 완료 시점의 code-server PID를 기록해두고 라이브 PID가 달라지면 자동 해제 — 별도 clear API 불필요), 삭제 확인을 `ConfirmDialog`로; 터미널 탭 드래그 순서변경(localStorage), 고정=닫기방지로 통합, 활성 탭에서만 편집/고정 토글 노출(비활성 고정 탭은 표시만), 홈 탭 제목 편집 가능(`TerminalSettings`에 영속화), 프로파일 생성 다이얼로그 세로 배치+아이콘 버튼, 쉘에 실행중인 자식 프로세스가 있으면 탭 닫기 전 확인(`termsession.Info.Pid`를 `/api/processes` 트리와 대조); 프로젝트 폴더 전체 삭제(이름 입력+체크박스 확인, `Scanner.DeleteProject`), 상세보기를 인라인 확장 대신 Sheet로, 열기/새로고침을 아이콘 버튼화; 작업관리자 코어별 그래프 폭 고정 버그+테마 미반영 버그 수정, 전체 코어 그리드 space-between 배치, 디스크 사용량을 여유공간 프레이밍 대신 폴더별 비중 프레이밍으로; SSH 키 추가/주석추가를 페이지 하단 인라인 폼 대신 테이블 헤더의 다이얼로그로; 파일매니저·Supervisor 행 동작을 아이콘 버튼화(Supervisor는 supervisord 설명문의 pid/uptime 중복 텍스트도 제거); 사이드바에 섹션별 아이콘 + 호버 시 드래그 핸들로 크로스페이드 + 로고 마크(파비콘 겸용) 추가 | 문서 없음(QA 피드백 일괄 처리, 각 항목은 위 표의 기존 기능에 대한 개선) |
| Projects 탭 상세 시트 확장(신규) — git worktree 목록/삭제(`internal/projectgit/worktree.go`, 목록은 게이트 없음/삭제는 `git worktree remove` 실 변경이라 비밀번호 게이트+확인 다이얼로그, `components/common/Git/WorktreesPanel.tsx`), 그 프로젝트를 건드린 Claude Code 대화 세션 기록(`GET /api/claude/sessions?project=`, `internal/claudecode.FilterSessionsByProject`, Claude Code 탭의 세션 로그 뷰어를 그대로 재사용해 동일하게 비밀번호 게이트, `components/Projects/ProjectSessionHistory.tsx`), Claude Code 자동 메모리 뷰어(`CLAUDE_CONFIG_DIR/projects/<slug>/memory/`, `internal/claudememory`, 정제된 노트라 게이트 없음, 기본 접힘 + 지연 로딩, `components/Projects/ProjectMemoryPanel.tsx`) — 세 패널 모두 `GitStatusPanel`과 같은 "path 하나만 받는" 컴포넌트 관례. Git Config 탭에는 전역 gitignore(`core.excludesFile`) 원본 편집(`internal/gitconfig/excludesfile.go`, `GET` 게이트 없음/`PUT` 게이트, `components/GitConfig/GlobalGitignore.tsx`)도 추가됨 | 문서 없음(2026-08-09, 커밋 0e2d361..b770dfc, 4개 병렬 worktree 에이전트로 진행 — 아직 실컨테이너 QA 전) |
| Projects 탭 "git clone으로 새 프로젝트" 다이얼로그(신규) — URL/대상 폴더 이름(자동 채움, 편집 가능)/저장 위치(scan root가 둘 이상일 때만 노출) 입력, `POST /api/projects/clone`이 백그라운드 job으로 `git clone --progress -- <url> <dest>` 실행(`internal/projects.Scanner.PrepareClone`이 root는 설정된 scan root와 정확히 일치, name은 `/` 없는 엄격한 charset으로 검증 — 아직 존재하지 않는 새 폴더라 대조할 캐시가 없어 exact-match 대신 charset 화이트리스트 채택), URL은 `--` 구분자 뒤에 별도 인자로 전달(플래그 오인 방지, `RemoveWorktree`와 동일 관례). 진행률은 `mise.JobStore`를 하나 더 인스턴스화한 `s.projectJobs`(`GET /api/projects/jobs/{id}`, mise 탭과 job id/TTL 안 섞임)로 폴링, 표시는 Mise 탭의 `JobPanel` 재사용. 성공 시 백엔드가 자동으로 전체 재스캔 트리거. clone 시작은 비밀번호 게이트, 진행률 폴링은 읽기라 게이트 없음 | 문서 없음(작은 기능 추가, 별도 계획 문서 없이 진행) |
| 폰트 매니저(신규, `internal/fonts`) — ttf/otf/woff/woff2 업로드+family별 아코디언 목록/편집/삭제(`GET/POST/PATCH/DELETE /api/fonts*`, 읽기·CSS·파일 서빙은 게이트 없음/쓰기만 게이트), `GET /api/fonts/css`가 매 요청 생성하는 `@font-face` 정의를 webmanager 자신의 `index.html`이 `<link>`로, code-server는 새 code-patch `config/code/code-patch/fonts.default.css`(내용이 절대 안 바뀌는 한 줄짜리 `@import`)로 각각 로드 — code-server 쪽은 강제 적용 없이 `editor.fontFamily`/`terminal.integrated.fontFamily`에 이름을 직접 넣으면 브라우저가 알아서 매칭(Fonts 탭에 안내문+복사 버튼). webmanager 자신의 웹터미널만 `internal/terminalsettings.Settings.FontFamily`로 선택 폰트를 실제 xterm 옵션에 반영. 컨테이너 첫 부팅 시 Victor Mono+IBM Plex Mono Nerd(Mono 배리언트) 런타임 다운로드(`SEED_DEFAULT_FONTS`로 opt-out, 실패해도 warn+skip) | `.claude/archive/font-manager-plan-done.md` (레포 루트) |
| 인터랙티브 터미널 Claude Code 로그인(신규, `InteractiveLoginDialog.tsx` + `internal/claudecode/interactivelogin.go`) — 헤드리스 `claude auth login` 프록시(위 행)가 실은 `~/.claude.json`의 `hasCompletedOnboarding` 플래그(로그인 여부와 별개)를 절대 세팅 못 해서 code-server 터미널에서 맨 `claude`를 치면 여전히 첫 실행 마법사가 뜨는 버그를 실측으로 잡고 고침(2026-08-11 인시던트) — `termsession.NewStandalone`으로 `claude` 바이너리를 셸 없이 PTY 리더로 직접 실행(Registry 미등록이라 Terminal 탭 세션 목록엔 안 뜸), xterm.js로 실시간 임베드. 어느 로그인 경로가 기본으로 뜰지는 `GET /api/claude/onboarding-status`(`hasCompletedOnboarding` 단순 파일 읽기)로 결정 — 이미 온보딩된 경우 헤드리스가 기본+터미널은 "고급" 폴백, 아직이면 반대. 다이얼로그 자체도 `auth.loggedIn`이 아니라 이 플래그를 폴링해서 닫는 타이밍을 잡음(loggedIn은 온보딩 마법사의 남은 화면보다 먼저 true가 됨 — 확인 화면 다 안 거치고 닫으면 똑같은 버그 재발). `/login` 슬래시커맨드 버튼(이미 온보딩된 상태에서 레이스로 마법사를 건너뛰는 경우의 안전망), OSC 52 클립보드 핸들러(xterm.js 기본 미지원이라 직접 등록) 포함 | 문서 없음(2026-08-11, CLAUDE.md 본문에 상세 기록) |

전체 구현은 backend(Go)/frontend(React) subagent를 병렬로 여러 라운드 돌려서 진행,
각 라운드 사이 API 계약 불일치를 직접 대조해서 잡는 패턴 반복 — 새 기능도 이 방식
유지 권장(자세히는 `.claude/base/architecture.md`).

**실제 컨테이너 검증**: 2026-08-02, `docker compose build && up`으로 전체 통합 확인
완료 (7개 supervisord program 전부 RUNNING, `docker compose logs` 라벨링 정상,
`/api/*` 전 엔드포인트 실응답 확인). 이후 `.claude/archive/webmanager-review.md` (레포 루트) 리뷰 라운드에서
나온 버그(critical 2건 포함)도 전부 수정 후 재검증 완료.

2026-08-02~08-04 사이 추가된 기능 대부분(테마 토글, 단일 origin 통합, dind
M1~M3, Tailscale 상태 조회, Claude Code 설치/로그인 자동화, 터미널 홈 탭, 전방위
QA 라운드, 프로젝트별 git 상태 패널 등)은 이후 실제로 저장소 소유자가 실컨테이너에서
확인을 마쳐 `.claude/archive/`로 옮겨졌음 — 각 기능의 실컨테이너 검증 상세는 해당
아카이브 문서에 남아있음, 여기서 반복 안 함. 아직 실컨테이너 확인이 안 끝난 것만
`.claude/README.md`의 "사용자 QA 대기" 표(`qa-request/`)에 남아있으니 그쪽을 볼 것.

tailscale 컨테이너 내 릴레이(DERP) 편중 현상에 대한 리서치도 진행—
userspace-networking 모드 자체는 direct 연결을 막지 않고, Docker 브리지
NAT도 보통은 무해하지만 UPnP/NAT-PMP 자동 포트매핑만은 브리지에서 끊김. 코드
변경은 하지 않음 — 먼저 컨테이너 안에서 `tailscale netcheck`로 호스트 바깥
네트워크의 실제 NAT 유형을 확인해보고, "mappable"이면 그때 `docker-compose.yml`에
`41641:41641/udp` 게시 + 호스트 라우터 포트포워딩을 시도해볼 가치가 있음(CGNAT/symmetric
NAT면 이 변경은 의미 없음 — 먼저 확인 필요).

## 할 일 (우선순위 순, 문서 있으면 링크)

1. **Claude Code 상태/관리 탭 M4~M5** — M1~M3는 구현 완료(설치/버전확인/로그인
   자동화는 별도 트랙으로 이미 구현됨, 위 참고). 다음은 M4(익스텐션 설치 배너,
   이미 구현된 익스텐션 API 재사용 가능). `.claude/claude-rework-v2.md`
2. **익스텐션 검색/URL 설치**(마켓플레이스 URL 붙여넣기 → open-vsx 교차 조회 →
   vsix 직접 설치 폴백) — 설계 완료, 미착수. `.claude/extension-search-plan.md`
3. code-server 설정(settings.json 등) 편집 UI — 후순위, 타당성 재검토 필요(`ideas.md`)
4. `/code/.local/share/code-docker/vector/logs/*.jsonl` 보존기간(retention) 정책 없음 — 알려진 갭
   (`.claude/archive/webmanager-review.md` (레포 루트) 참고), 문서 없음
5. code-docker 도움말/가이드를 webmanager에 임베드 — 아이디어 단계, 착수 전
   질문 정리 완료. `.claude/research/guide-plan.md`
6. **code-server/mise 버전 관리 패널** — **최하 우선순위**(guide-plan과 동급),
    아이디어 단계, 착수 전 질문 다수 정리 완료(특히 "컨테이너 리빌드 필요성"
    판단 기준이 근본적으로 불확실). claude-code 하나만의 mise 버전확인은 이미
    별도로 구현 완료됨(위 표) — 이 항목은 code-server/서브모듈/베이스 이미지까지
    아우르는 더 큰 범위라 혼동하지 말 것. `.claude/research/version-panel-plan.md`
7. 다국어(i18n) 지원, 아마 LinguiJS — 모든 기능이 안정되고 문자열이 안 바뀌기
    시작할 때 착수 예정, 아이디어 단계, 문서 없음.
8. **파일 매니저 리워크**(드래그앤드롭 이동, 그리드/리스트/테이블 뷰,
    멀티탭) — **최하 우선순위**, Termix류 프로젝트를 벤치마킹하자는 아이디어
    단계. 복잡하고 필수 기능은 아니라서 낮은 우선순위 — 착수 전 스코프를
    사용자와 반드시 논의. `.claude/research/filemanager-rework-plan.md`

## 참고 문서

- **API 정확한 스펙**: `webmanager/backend/README.md`, `webmanager/frontend/README.md`
  (구현된 그대로 최신 유지되는 원본)
- **기능별 설계/이력**: `webmanager/.claude/` (README로 인덱스)
- **아이디어 백로그**(아직 계획 문서 없는 브레인스토밍): `webmanager/ideas.md`
- **프로젝트 리뷰**: `.claude/archive/webmanager-review.md` (레포 루트)
- **저장소 소유자가 답해야 할 질문 전체 취합**: `.claude/question.md`
