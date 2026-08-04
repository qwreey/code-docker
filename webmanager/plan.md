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
인증은 forward-auth 전적 위임(자체 로그인 없음), 바인드 주소는 `private:81`(전용
tailscale IP, 레포 루트 `docs/tailscale.md` 참고 - tailnet 자동노출 방지).

## 구현 완료

| 기능 | 문서 |
|---|---|
| Supervisor 프로세스 관리 | `.claude/archive/supervisor-plan-done.md` |
| SSH authorized_keys 관리 | `.claude/qa-request/sshkeys-plan-done.md` |
| Git 설정(user/email, 커밋 사이닝, SSH 호스트, HTTPS credential, git-lfs install, .gitconfig 원본 편집) | `.claude/qa-request/gitconfig-plan-done.md` |
| Tailscale forwards/publish CRUD + 상태 조회(로그인 필요 시 배너, 내 정보/피어 목록, `GET /api/tailscale/status`) | `.claude/archive/tailscale-plan-done.md` |
| vector 로그 파이프라인 + Logs 페이지 | `.claude/archive/vector-logs-plan-done.md` |
| 작업 관리자(구 "Processes") — 성능/프로세스 서브탭 분리, 프로세스 트리+리스트, 필터/검색, 코어별 CPU 히트맵(호버 시 최근 히스토리 스파크라인 포함), 메모리 구성요소별 분해(호스트 물리 vs cgroup), 컨테이너 자체 루트 파일시스템의 최상위 디렉토리별 디스크 사용량 분석(Storage Sense류, `du` 기반, 캐시 + 수동 새로고침 전용) | `.claude/archive/processes-plan-done.md` |
| Docker/dind 관리 M1(읽기 전용 — 컨테이너/이미지 목록, 로그 조회, `internal/dind` CLI 셸아웃)+M2(start/stop/remove, 확인 다이얼로그 필수, 비밀번호 게이트)+M3(docker inspect 상세 뷰, 비밀번호 게이트 — Config.Env 평문 노출 우려로 list/logs와 달리 게이트) | `.claude/qa-request/dind-plan-done.md` |
| Claude Code 상태 탭 M1(퀵 오버뷰)+M2(히트맵/주간그래프/모델별 토큰)+M3(Skills/Plugins) + 설치 버튼(mise 재사용)/mise 버전 확인·업데이트/버전 확인 무시 체크박스(백엔드 영속)/브라우저 내 로그인 자동화(`claude auth login` 서브프로세스 프록시, 파이프만으로 충분함을 실측 확인 — PTY 불필요) | `.claude/claude-plan.md` (M4~M5는 미착수, 로그인/설치/버전확인은 별도 트랙으로 이번에 구현 완료) |
| code-server 익스텐션 추천/설치 (카테고리별 그룹핑, open-vsx "더 보기" 링크, 삭제(uninstall) 포함) | `.claude/archive/extensions-plan-done.md` |
| 프로젝트 스캔/정리 1단계(용량/재생성 가능 폴더 탐지, 최근 편집 런처, mise 도구 표시)+2단계(재생성 가능 폴더 단위 삭제, 확인 다이얼로그 필수, 비밀번호 게이트) | `.claude/qa-request/projects-plan-done.md` |
| mise 관리(install/use/uninstall, 설치된 도구 목록, env 미리보기, 추천 목록) | `.claude/qa-request/mise-plan-done.md` |
| 웹쉘(터미널) M1(임시 세션, xterm.js+PTY/WebSocket, 비밀번호 게이트 소급 적용됨) + M2(named 영속 세션, `internal/termsession`, 탭 UI/유지 토글/유휴 자동정리) + 모바일 레이아웃 재설계(키보드 추적, 엣지투엣지, 테마 동화 색상) | `.claude/archive/terminal-plan-done.md` |
| 터미널 홈 탭(항상 열려있는 첫 탭 — 세션 목록 전환 + 시작 위치/실행 명령을 저장하는 프로파일 CRUD, 세션 생성 시 cwd/초기 명령 지원하도록 `internal/termsession` 확장) | `.claude/qa-request/terminal-home-plan-done.md` |
| 공용 비밀번호 게이트(`internal/authgate`, argon2id + ENV 전용 저장, 읽기 열림/쓰기 게이트 원칙으로 Git/SSH/Tailscale/Supervisor/Logs까지 확장) | `.claude/authgate-plan-done.md` (터미널 탭이 아직 `RequiresUnlock`으로 안 감싸진 실제 갭 있음 — 문서 참고, 그래서 archive 안 됨) |
| 파일 매니저(업로드/다운로드/이동/복사/이름변경/폴더생성/멀티선택/정보패널/텍스트편집, 자체 비밀번호 게이트) | `.claude/archive/filemanager-plan-done.md` (업로드 진행률/chmod/zip 다운로드 등 v1 잔여 항목은 `.claude/filemanager-rework-plan.md`) |
| 공용 코드 에디터(CodeMirror 6, 지연 로딩) — git raw 설정 편집/파일 매니저가 재사용 | 별도 문서 없음(공용 컴포넌트, `src/components/common/CodeEditor.tsx`) |
| Supervisor 로그 다이얼로그/바텀시트, 반응형 레이아웃(모바일 햄버거 사이드바), 로그 페이지네이션/시간범위 필터, CPU/메모리/디스크/네트워크 사용량 히스토리 그래프, 사이드바 드래그앤드롭 순서 변경(서버에 저장, `GET/PUT /api/ui/sidebar-order`), 탭 이름 영어로 통일(Code Extensions/Projects/Task Manager/Files) | 문서 없음(UI/관측성 개선, 각 기능 자체는 위 표의 해당 기능 문서 소관) |
| `docker-compose.yml`에 모든 `WEBMANAGER_*` env var를 주석 처리된 상태로 문서화(값 예시는 안 채움, 필요할 때 주석 해제), locale(`LANG`)도 TZ 옆에 주석으로 추가 | 문서 없음(레포 루트 `docker-compose.yml` 자체가 최신 소스) |
| Light/Dark 수동 토글(3-way: 자동/라이트/다크, `data-theme` 속성 + `localStorage`) + 사이드바 하단 잠금 상태 표시/미리 해제 + `index.css` 컬러 시스템 중앙화(기본 UI 다크 값 신규 설계 포함 — 원래 전혀 없었음, dataviz 스킬로 차트 팔레트 재검증) | `.claude/archive/theme-toggle-plan-done.md` |
| `.env.webmanager` 마이그레이션 도구(`webmanager --env-migrate` — 키 추가/삭제 반영(삭제된 키는 `#~` 아카이브 섹션으로), 유저 코멘트 보존, `#!important`/`#!` 마커로 조직 강제값·권장값-변경-충돌 표시, 경로 기반 템플릿(조직 커스텀 마운트 가능) + 기동 로그/웹 UI 경고 배너(dismiss 영속화)) | `.claude/qa-request/env-migration-plan-done.md` |
| code-server(`/`)+webmanager(`/manager`)를 컨테이너 안 nginx로 단일 origin 통합 — code-server/webmanager 내부 포트 이동, `code-config.yaml` 매 시작 재생성, 프론트엔드 서브패스(`apiUrl()`/`BASE_URL`) 대응까지 전부 구현 | `.claude/qa-request/expose-plan-done.md` |
| 바인드 주소 전략 확정(구 TODO 5번) — code-server/webmanager를 loopback(`127.0.0.1`) 대신 전용 tailscale IP(`private` 호스트네임)에 바인드, nginx `listen 127.0.0.1:80`으로 tailscale 자동 loopback 포워딩 경로 차단, `ALLOWED_HOSTS`(nginx Host 헤더 화이트리스트) 추가 | 레포 루트 `docs/tailscale.md`의 "보안: tailnet ACL 설정" 절 (전용 webmanager 문서 없음 - nginx/code-server/docker-compose.yml 전체에 걸친 변경이라 레포 루트 문서가 소관) |
| mise 전역 설치/삭제 성공 후 code-server 재시작을 눌러서 바로 실행 가능(`POST /api/supervisor/processes/code-server/restart` 재사용, `frontend/src/utils/restartCodeServer.ts`) — 정적 안내문에서 버튼으로 승격, 잡 진행 패널(`Mise/JobPanel.tsx`)을 Mise 탭/Claude 탭이 공유하도록 추출 | 문서 없음(작은 갭 메우기, 별도 계획 문서 없이 진행) |
| Claude 탭 안 대화 로그 뷰어 v1 — 프로젝트 전체의 세션 트랜스크립트 목록/축약 채팅뷰(`CLAUDE_CONFIG_DIR/projects/*/*.jsonl`), 백엔드는 목록+원본 라인 페이지네이션만 제공하고 파싱은 프론트가 벤더링한 Zod 스키마(`d-kimuson/claude-code-viewer` MIT)로 처리, Terminal/Files/Logs와 동급으로 비밀번호 게이트 | `.claude/session-log-plan.md` |
| Dev Proxy 탭 — 내부 Caddy 인스턴스(`caddy-adapter` supervisord program)로 dev 서버를 와일드카드 서브도메인에 노출, `internal/devproxy`(Caddyfile 조각 CRUD, `caddy adapt` 검증 후 `caddy reload`), 인증은 `internal/authgate`를 Caddy `forward_auth`에 연결(`GET /api/auth/verify`, 독립 로그인 페이지 `/manager/dev-auth`) — authgate 자체도 이번에 세션 저장소 없는 HMAC 서명 토큰으로 재설계되어 웹매니저 쓰기 게이트(10분)와 dev-proxy 열람(24시간)을 같은 토큰으로 다른 TTL로 검사 | `.claude/research/caddy-plan.md`(원래 "인증은 바깥에 위임" 결정이 뒤집힘 — 문서 상단에 갱신됨) |
| 프로젝트별 git 상태 패널(신규, `internal/projectgit`) — staged/changed/untracked/behind/ahead/diverged/stashed/conflicts 요약(파싱 로직은 `~/.config/fish/functions/quiteline-fish/_qtm_git_info.fish`의 `git status --porcelain -b` 분류 규칙을 그대로 이식), 커밋 로그(커서 페이지네이션)/커밋별 diff/미변경·스테이지 diff(직접 만든 +/- 라인 색칠, 새 의존성 없음)/리모트/브랜치/태그 조회. 읽기 전용만 구현(스테이징/커밋/push·pull/merge·rebase 도구는 다음 마일스톤으로 보류), 모든 엔드포인트는 프로젝트 경로를 알려진 프로젝트 목록과 정확히 일치시켜 검증한 뒤에만 `git` 셸아웃, 전부 읽기라 게이트 없음. 프론트는 `components/common/Git/`에 프로젝트 경로 하나만 받는 형태로 위치 — 파일매니저 리워크 등 다른 곳에서도 재사용 가능하게 의도적으로 분리 | 문서 없음(신규 기능, 별도 설계 문서 없이 한 라운드로 구현) |
| 전방위 QA 라운드 — 공용 `ConfirmDialog` 컴포넌트화(기존 `Sheet`와 함께 다이얼로그 표준화, `KillConfirmDialog`/`DeleteReclaimableDialog`가 이걸 감싸는 얇은 래퍼로 정리, 터미널 프로파일 삭제의 남은 `window.confirm` 홀드아웃도 정리); Claude Code 설치 오버레이가 `position: fixed`로 사이드바까지 덮어 못 빠져나가던 버그 수정(탭 콘텐츠에만 스코프) + 설치 완료 후 로그를 볼 수 있게 자동전환 대신 "다시 로드" 버튼 + 설치 job id를 localStorage에 영속화(탭 이동 후 복귀해도 진행 이어봄) + 로그인 링크를 버튼화(Tailscale 탭과 동일 패턴); mise/익스텐션 재시작 필요 플래그를 백엔드에 영속화(`internal/restartstatus`, 설치 완료 시점의 code-server PID를 기록해두고 라이브 PID가 달라지면 자동 해제 — 별도 clear API 불필요), 삭제 확인을 `ConfirmDialog`로; 터미널 탭 드래그 순서변경(localStorage), 고정=닫기방지로 통합, 활성 탭에서만 편집/고정 토글 노출(비활성 고정 탭은 표시만), 홈 탭 제목 편집 가능(`TerminalSettings`에 영속화), 프로파일 생성 다이얼로그 세로 배치+아이콘 버튼, 쉘에 실행중인 자식 프로세스가 있으면 탭 닫기 전 확인(`termsession.Info.Pid`를 `/api/processes` 트리와 대조); 프로젝트 폴더 전체 삭제(이름 입력+체크박스 확인, `Scanner.DeleteProject`), 상세보기를 인라인 확장 대신 Sheet로, 열기/새로고침을 아이콘 버튼화; 작업관리자 코어별 그래프 폭 고정 버그+테마 미반영 버그 수정, 전체 코어 그리드 space-between 배치, 디스크 사용량을 여유공간 프레이밍 대신 폴더별 비중 프레이밍으로; SSH 키 추가/주석추가를 페이지 하단 인라인 폼 대신 테이블 헤더의 다이얼로그로; 파일매니저·Supervisor 행 동작을 아이콘 버튼화(Supervisor는 supervisord 설명문의 pid/uptime 중복 텍스트도 제거); 사이드바에 섹션별 아이콘 + 호버 시 드래그 핸들로 크로스페이드 + 로고 마크(파비콘 겸용) 추가 | 문서 없음(QA 피드백 일괄 처리, 각 항목은 위 표의 기존 기능에 대한 개선) |

전체 구현은 backend(Go)/frontend(React) subagent를 병렬로 여러 라운드 돌려서 진행,
각 라운드 사이 API 계약 불일치를 직접 대조해서 잡는 패턴 반복 — 새 기능도 이 방식
유지 권장(자세히는 `.claude/base/architecture.md`).

**실제 컨테이너 검증**: 2026-08-02, `docker compose build && up`으로 전체 통합 확인
완료 (7개 supervisord program 전부 RUNNING, `docker compose logs` 라벨링 정상,
`/api/*` 전 엔드포인트 실응답 확인). 이후 `.claude/archive/webmanager-review.md` (레포 루트) 리뷰 라운드에서
나온 버그(critical 2건 포함)도 전부 수정 후 재검증 완료.

2026-08-03에 추가된 CPU 코어 히트맵 히스토리 스파크라인, dind M1+M2는 `go build`/
`go vet`/`gofmt` + `npm run build`/`npm run lint`만 통과했고 아직 실컨테이너
통합 검증(`docker compose build && up`)은 안 함 — dind는 특히 `code-docker-dind`
사이드카가 실제로 떠 있어야 의미 있게 확인 가능.

같은 날 추가된 테마 토글/컬러 시스템 중앙화도 `npm run build`/`npm run lint`는
클린이고 DOM/computed style/기능 동작(클릭 → localStorage/`data-theme` 반영)은
헤드리스 브라우저로 직접 확인했지만, 실제 데이터가 있어야 그려지는 요소(히트맵
셀, 뱃지 등)의 실제 색상은 백엔드 없이 확인 못 했음(자세히는
`.claude/archive/theme-toggle-plan-done.md`) — 도커에서 라이트/다크 둘 다 훑어봐 주는 걸
권장.

`expose-plan.md`(단일 origin 통합)도 `go build`/`go vet`/`npm run build`/`npm run
lint`까지만 통과했고 실컨테이너 검증은 아직 — nginx가 새로 추가된 supervisord
program이라 `docker compose build && up` 후 7→8개 program 전부 RUNNING인지,
`/manager` 경로/웹쉘 WebSocket/파일 업로드가 실제로 통과하는지 직접 확인
필요(`.claude/qa-request/expose-plan-done.md` 참고).

같은 날 이어서 추가된 dind M3(docker inspect 상세 뷰, 비밀번호 게이트)도
`go build`/`go vet`/`gofmt` + `npm run build`/`npm run lint`만 통과했고
아직 실컨테이너 통합 검증은 안 함 — M1/M2와 마찬가지로 `code-docker-dind`
사이드카가 실제로 떠 있어야 의미 있게 확인 가능(`.claude/qa-request/dind-plan-done.md` 참고).

같은 날(2026-08-03) 추가된 Tailscale 상태 조회, Claude Code 설치/mise 버전확인/
브라우저 내 로그인 자동화, mise 재시작 다이얼로그도 전부 `go build`/`go vet`/
`gofmt` + `npm run build`/`npm run lint`만 통과했고 아직 실컨테이너 검증 전 —
특히 로그인 자동화는 `claude auth login`이 비-tty 파이프로 정상 동작함을 호스트에서
격리된 임시 `$HOME`으로 직접 실행해 확인했지만(실제 코드 붙여넣기 전 kill, 실제
인증은 안 함), 코드 붙여넣기까지 포함한 전체 플로우를 컨테이너 안에서 끝까지
눌러본 적은 없음 — 사용자가 직접 한 번 로그인까지 완주해보는 걸 권장. Tailscale
상태 탭도 실제 tailnet 연결 상태에서 피어/relay 표시가 맞는지 실기 확인 필요.

같은 날 이어서 추가된 터미널 홈 탭도 `go build`/`go vet`/`gofmt`/`go test ./...`
+ `npm run build`/`npm run lint`만 통과했고 아직 실컨테이너 검증 전 — 프로파일의
cwd/초기 명령이 실제 셸에서 기대대로 동작하는지, 홈 탭 진입/전환/탭 닫기 후 복귀가
매끄러운지 직접 확인 필요(`.claude/qa-request/terminal-home-plan-done.md` 참고).

2026-08-04에 진행된 QA 일괄 처리 + 프로젝트별 git 상태 패널도 `go build`/`go
vet`/`gofmt`/`go test ./...` + `npm run build`/`npm run lint`만 통과했고 아직
실컨테이너 검증 전. 특히 직접 확인이 필요한 부분: Claude Code 설치 job
id를 localStorage에 영속화한 부분(탭 이동 후 복귀 시 진행 상황이 실제로
이어지는지), mise/익스텐션 재시작 필요 배너가 code-server 재시작 후 실제로
자동 해제되는지, 터미널 탭 닫기 확인이 실제 실행중 프로그램(vim, 서버 프로세스
등) 유무를 정확히 판별하는지(foreground vs background job 구분은 못 하는
알려진 한계), git 상태 패널을 실제 git 저장소가 있는/없는 프로젝트 양쪽에서
열어보기. 이번 라운드 진행 중 한 서브에이전트가 실수로 스코프 없는 `git
stash`를 실행해 다른 에이전트들의 작업을 일시적으로 되돌린 사고가 있었음 —
전부 복구/재확인 후 커밋했지만(`eec9805`~현재 HEAD 사이 9개 커밋), 혹시
모를 누락이 있는지 `git log`로 훑어보는 것도 권장.

tailscale 컨테이너 내 릴레이(DERP) 편중 현상에 대한 리서치도 이번에 진행—
userspace-networking 모드 자체는 direct 연결을 막지 않고, Docker 브리지
NAT도 보통은 무해하지만 UPnP/NAT-PMP 자동 포트매핑만은 브리지에서 끊김. 코드
변경은 하지 않음 — 먼저 컨테이너 안에서 `tailscale netcheck`로 호스트 바깥
네트워크의 실제 NAT 유형을 확인해보고, "mappable"이면 그때 `docker-compose.yml`에
`41641:41641/udp` 게시 + 호스트 라우터 포트포워딩을 시도해볼 가치가 있음(CGNAT/symmetric
NAT면 이 변경은 의미 없음 — 먼저 확인 필요).

## 할 일 (우선순위 순, 문서 있으면 링크)

1. **Claude Code 상태/관리 탭 M4~M5** — M1~M3는 구현 완료(설치/버전확인/로그인
   자동화는 별도 트랙으로 이미 구현됨, 위 참고). 다음은 M4(익스텐션 설치 배너,
   이미 구현된 익스텐션 API 재사용 가능). `.claude/claude-plan.md`
2. **익스텐션 검색/URL 설치**(마켓플레이스 URL 붙여넣기 → open-vsx 교차 조회 →
   vsix 직접 설치 폴백) — 설계 완료, 미착수. `.claude/extension-search-plan.md`
3. code-server 설정(settings.json 등) 편집 UI — 후순위, 타당성 재검토 필요(`ideas.md`)
4. `/code/.vector/logs/*.jsonl` 보존기간(retention) 정책 없음 — 알려진 갭
   (`.claude/archive/webmanager-review.md` (레포 루트) 참고), 문서 없음
6. code-docker 도움말/가이드를 webmanager에 임베드 — 아이디어 단계, 착수 전
   질문 정리 완료. `.claude/research/guide-plan.md`
7. **code-server/mise 버전 관리 패널** — **최하 우선순위**(guide-plan과 동급),
    아이디어 단계, 착수 전 질문 다수 정리 완료(특히 "컨테이너 리빌드 필요성"
    판단 기준이 근본적으로 불확실). claude-code 하나만의 mise 버전확인은 이미
    별도로 구현 완료됨(위 표) — 이 항목은 code-server/서브모듈/베이스 이미지까지
    아우르는 더 큰 범위라 혼동하지 말 것. `.claude/research/version-panel-plan.md`
9. **활성 세션 목록 보기**(어디서 로그인/접속해있는지 보기) — **최하
    우선순위**, 아이디어 단계. "세션"이 뭘 뜻하는지부터(webmanager 자체
    비밀번호 게이트 세션? code-server 자신의 연결? Authentik 세션?) 불명확해서
    착수 시 반드시 사용자와 인터랙티브하게 스코프 확인 필요 — 혼자 판단해서
    구현 진행하지 말 것. `.claude/research/session-viewer-plan.md`
10. 다국어(i18n) 지원, 아마 LinguiJS — 모든 기능이 안정되고 문자열이 안 바뀌기
    시작할 때 착수 예정, 아이디어 단계, 문서 없음.
11. **파일 매니저 리워크**(드래그앤드롭 이동, 그리드/리스트/테이블 뷰,
    멀티탭) — **최하 우선순위**, Termix류 프로젝트를 벤치마킹하자는 아이디어
    단계. 복잡하고 필수 기능은 아니라서 낮은 우선순위 — 착수 전 스코프를
    사용자와 반드시 논의. `.claude/filemanager-rework-plan.md`

## 참고 문서

- **API 정확한 스펙**: `webmanager/backend/README.md`, `webmanager/frontend/README.md`
  (구현된 그대로 최신 유지되는 원본)
- **기능별 설계/이력**: `webmanager/.claude/` (README로 인덱스)
- **아이디어 백로그**(아직 계획 문서 없는 브레인스토밍): `webmanager/ideas.md`
- **프로젝트 리뷰**: `.claude/archive/webmanager-review.md` (레포 루트)
- **저장소 소유자가 답해야 할 질문 전체 취합**: `.claude/question.md`
