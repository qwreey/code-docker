# webmanager/.claude/ — 기능별 계획 문서

webmanager만을 위한 계획/설계 문서 모음 (레포 전체에 걸치는 건 루트 `.claude/`).
`webmanager/plan.md`는 이 전체를 아우르는 짧은 현재 상태 요약 — 먼저 그걸 보고,
특정 기능의 자세한 내용/이유가 필요할 때만 아래 개별 문서를 열어볼 것.

**이 폴더 바로 아래(서브폴더 없이)에는 지금 착수 가능한 작업 문서만 둔다.**
그 외(완료/아카이브, 사용자 QA 대기, 공동 리서치 필요, 피드백 로그, 프로젝트
전체 컨텍스트)는 전부 아래 서브폴더로 분류한다:

| 폴더 | 기준 |
|---|---|
| `archive/` | 완료 + **사용자가 실사용으로 직접 검증까지 마침** — 재작업 대상 아님 |
| `qa-request/` | 완료(코드/에이전트 검증까지는 끝남) + **사용자 본인의 실컨테이너 QA만 남음** — QA 끝나면 `archive/`로 |
| `research/` | 아직 착수 전, **사용자와 함께 스코프/설계를 더 상의해야 함** |
| `feedback/` | 실사용 피드백을 정리·문서화한 긴 로그 (프로젝트 전체에 걸치거나 그 자체로 긴 QA 세션) |
| `base/` | 계획(plan)이 아니라 프로젝트 전체에 걸치는 컨텍스트/고지 문서 — 완료 상태 개념이 없음 |

바로 아래 남는 파일은 지금 착수 가능한 작업(`*-plan.md`)과 `README.md`/
`question.md` 같은 인덱스류뿐이다. 어떤 문서가 "완료"가 되면 위 기준에 따라
`archive/` 또는 `qa-request/`로 옮길 것 — 바로 아래에 완료 문서를 남겨두지 않는다.

**저장소 소유자가 답해야 할 질문이 있으면 `question.md`에 전부 모아둠** —
각 plan 문서에 흩어진 "사용자 확인 필요" 절의 취합본. 구현을 막고 있진 않음
(전부 합리적 기본값으로 진행 중), 시간 날 때 훑어보고 기본값이 마음에 안 드는
것만 답하면 됨.

**긴 실사용 피드백/QA 로그는 `feedback/`에 문서화** — 프로젝트 전체에 영향을
주거나, 그 자체로 길게 정리·문서화가 필요한 QA는 이렇게 별도 파일로 분리한다.
반대로 특정 기능 하나에만 해당하는 피드백은 그 기능의 plan 문서 안에 바로
적는 게 낫다 — 새 `feedback/` 파일을 만들지 말 것. 에이전트가 피드백을 처리하다
분량이 길어져서 정리/문서화가 필요하다고 판단되면 이 규칙에 따라 `feedback/`에
새 파일을 추가하면 됨.

## 지금 착수 가능 (바로 이 폴더 아래, `*-plan.md`)

| 문서 | 기능 | 우선순위 |
|---|---|---|
| `claude-plan.md` | Claude Code 상태/관리 탭 — **M1~M3 구현 완료**, M4(익스텐션 배너)부터 미착수 | M4는 바로 가능 |
| `extension-search-plan.md` | 익스텐션 검색/마켓플레이스 URL 붙여넣기 설치 — "더 보기" 링크와 삭제(uninstall)는 이미 구현 완료돼서 이 문서에서 빠짐(각각 `archive/extensions-plan-done.md` 참고), 비활성화(disable)는 조사 후 미구현 결정 | M4 언저리, 급하지 않음 |
| `authgate-plan-done.md` | 공용 비밀번호 게이트(`internal/authgate`) — 대부분 완료지만 **터미널 탭이 아직 `RequiresUnlock`으로 안 감싸져 있어서 WS 업그레이드가 401일 때 조용히 실패하는 실제 미해결 갭이 있음**(문서 자체의 "아직 안 된 것" 절 참고) — 그래서 archive로 안 옮김 | 작음, 남는 대로 처리 가능 |

## 사용자 QA 대기 (`qa-request/*-plan-done.md`)

코드/에이전트 검증(`go build`/`npm run build`/`npm run lint`, 로컬 스모크
테스트)은 끝났지만, 사용자 본인이 아직 실컨테이너에서 확인 전이라 `archive/`로
안 옮긴 것들. 확인되면 `archive/`로 이동.

| 문서 | 기능 |
|---|---|
| `qa-request/sshkeys-plan-done.md` | SSH authorized_keys 관리 |
| `qa-request/gitconfig-plan-done.md` | git user/email, 커밋 사이닝(SSH/GPG), 호스트별 SSH 키, HTTPS credential, git-lfs install, .gitconfig 원본 편집, known_hosts 관리 |
| `qa-request/projects-plan-done.md` | 프로젝트 스캔/정리 1단계(용량/재생성 가능 폴더 탐지, 최근 편집 런처, mise 도구 표시, 읽기 전용 — 2단계 삭제는 미착수) |
| `qa-request/mise-plan-done.md` | mise 관리(install/use/uninstall, 설치된 도구 목록, env 미리보기) + 설치 추천 목록(접기, 표시 토글) |
| `qa-request/env-migration-plan-done.md` | `.env.webmanager` 마이그레이션 도구(`webmanager --env-migrate`) — 키 추가/삭제 반영(삭제된 키는 `#~` 아카이브), 유저 코멘트 보존, `#!important`/`#!` 마커, 경로 기반 템플릿(조직 커스텀 마운트 가능), 웹 UI 경고 배너(dismiss 영속화) |
| `qa-request/expose-plan-done.md` | code-server(`/`)+webmanager(`/manager`)를 컨테이너 안 nginx로 단일 origin 통합(레포 루트 `expose.md` 리서치를 대체) — M1(nginx)~M3(프론트엔드 서브패스 대응) 코드/빌드 검증까지 완료. code-server 쪽에서 매니저를 여는 위젯/PWA 바로가기는 별도 마일스톤으로 남아있음(질문만 정리, 착수 안 함) |
| `qa-request/dind-plan-done.md` | Docker/dind 관리 — M1(목록/로그, 읽기 전용)+M2(start/stop/remove, 비밀번호 게이트)+M3(docker inspect 상세 뷰, 비밀번호 게이트) 전부 코드/빌드 검증까지 완료 |
| `qa-request/terminal-home-plan-done.md` | 터미널 홈 탭 — 항상 열려있는 첫 탭에 세션 목록 전환 + 시작 위치/실행 명령 프로파일 CRUD, 세션 생성 시 cwd/초기 명령 지원하도록 `internal/termsession` 확장, 코드/빌드 검증까지 완료 |

## 완료, 사용자 실사용 검증까지 끝나서 아카이브됨 (`archive/*-plan-done.md`)

| 문서 | 기능 |
|---|---|
| `archive/supervisor-plan-done.md` | supervisord 프로세스 관리(목록/시작/정지/재시작/로그, 프로그램별 메타데이터로 특정 컨트롤 비활성화, PID 트리 펼침) |
| `archive/tailscale-plan-done.md` | tailscale forwards/publish 설정 CRUD (webmanager UI 쪽 — tailscaled 인프라 자체는 루트 `.claude/archive/tailscale-design.md`) |
| `archive/vector-logs-plan-done.md` | vector 로그 파이프라인 도입 + webmanager Logs 페이지(시간범위 필터, 커서 페이지네이션, 실시간 누적, 비밀번호 게이트) |
| `archive/processes-plan-done.md` | "작업 관리자" 탭(구 Processes) — 성능/프로세스 서브탭, 코어별 CPU 히트맵(호버 히스토리 스파크라인 포함), 메모리 구성요소별 분해, 프로세스 트리+리스트, 필터/검색, 페이지네이션, 컨테이너 루트 디스크 사용량 분석 |
| `archive/extensions-plan-done.md` | code-server 확장 추천/설치(카테고리별 그룹핑, 접기, 설치된 목록, 표시 토글, open-vsx "더 보기" 링크, 삭제(uninstall)) |
| `archive/filemanager-plan-done.md` | 파일 관리자(업로드/다운로드/이동/복사/이름변경/멀티선택/텍스트편집/정보패널, 자체 비밀번호 게이트) — v1에서 미뤄둔 잔여 항목(업로드 진행률/chmod/zip 다운로드/실컨테이너 검증)은 `filemanager-rework-plan.md`로 옮김 |
| `archive/terminal-plan-done.md` | 웹쉘 — M1(임시 세션)+M2(named 영속 세션, `internal/termsession`, 탭 UI/유지 토글/유휴 자동정리)+비밀번호 게이트+모바일 컨트롤/키바인딩/테마+모바일 키보드 대응 레이아웃, 전부 구현 완료 |
| `archive/theme-toggle-plan-done.md` | Light/Dark 수동 토글(3-way) + 사이드바 하단 잠금 상태 표시 + `index.css` 컬러 시스템 중앙화(다크 모드 기본 UI 토큰 신규 설계 포함) — "모든 컴포넌트는 색상을 하드코딩하지 말고 이 CSS 변수를 참조하라"는 가이드는 `frontend/src/index.css` 최상단 주석에 있음 |

## 공동 리서치 필요 (`research/*-plan.md`)

아이디어 단계 — 착수 전에 사용자와 스코프/설계를 더 상의해야 함.

| 문서 | 기능 | 우선순위 |
|---|---|---|
| `research/caddy-plan.md` | dev 서버를 와일드카드 서브도메인으로 자동 expose (Caddy 인스턴스) — 설계 대부분 확정, `preserve_host` 기본값 등 남은 결정 있음 | dind/터미널보다도 낮음 |
| `research/guide-plan.md` | code-docker 도움말/가이드를 webmanager에 임베드 — 아이디어 단계, 구현 안 함 | 미정(사용자 검토 대기) |
| `research/version-panel-plan.md` | code-server/mise 버전 관리 패널 — 아이디어 단계, "컨테이너 재빌드 필요"를 뭘로 판단할지부터 불명확 | 최하(guide-plan과 동급) |
| `research/session-viewer-plan.md` | 활성 세션 목록 보기 — 아이디어 단계, "세션"의 정의부터 불명확해서 착수 시 사용자와 인터랙티브 확인 필수 | 최하 |
| `filemanager-rework-plan.md` | 파일 매니저 리워크(드래그앤드롭 이동, 그리드/리스트/테이블 뷰, 멀티탭) — Termix류 벤치마킹, 아이디어 단계, 착수 전 스코프를 사용자와 논의 필수. v1에서 미뤄둔 잔여 항목(업로드 진행률/chmod/zip 다운로드 등)도 여기 기록됨(리워크와는 별개) | 최하 |

`filemanager-rework-plan.md`는 최상위에 남아있음 — "착수 가능"이 아니라
"사용자와 상의 필요"라 원칙상 `research/`에 속하지만, 파일 매니저 관련
문서들끼리 묶어 찾기 쉽게 유지(대신 위 표에 실어서 분류는 명시).

## 프로젝트 전체 컨텍스트 (`base/`, plan/done 개념 없음)

| 문서 | 내용 |
|---|---|
| `base/architecture.md` | webmanager 전체 아키텍처(스택/인증/배포/개발 방식) — 특정 기능이 아니라 횡단 결정의 최종 상태 요약 |
| `base/history-raw.md` | 위 문서들로 나누기 전, 라운드별 원본 의사결정 로그(참고용 백업, 왠만하면 위 개별 문서로 충분함) |

## 실사용 피드백 로그 (`feedback/`)

| 문서 | 내용 |
|---|---|
| `feedback/feedback-2026-08-02.md` | 실제로 써보고 나온 개선 요청들을 어떻게 처리했는지(무엇을 구현했고, 무엇을 계획만 해뒀는지) 추적 — 다시 조사/구현하기 전에 먼저 확인할 것 |

전체 순서/우선순위는 `webmanager/CLAUDE.md`가 최종 소스 — 위 표의 "우선순위" 칸은
힌트일 뿐 그쪽이 바뀌면 이 표도 갱신할 것.
