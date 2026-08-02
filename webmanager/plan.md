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
| Git 설정(user/email, 커밋 사이닝, SSH 호스트, HTTPS credential, git-lfs install, .gitconfig 원본 편집) | `.claude/gitconfig-plan-done.md` |
| Tailscale forwards/publish CRUD | `.claude/tailscale-plan-done.md` |
| vector 로그 파이프라인 + Logs 페이지 | `.claude/vector-logs-plan-done.md` |
| 작업 관리자(구 "Processes") — 성능/프로세스 서브탭 분리, 프로세스 트리+리스트, 필터/검색, 코어별 CPU 히트맵, 메모리 구성요소별 분해(호스트 물리 vs cgroup) | `.claude/processes-plan-done.md` |
| Claude Code 상태 탭 M1(퀵 오버뷰)+M2(히트맵/주간그래프/모델별 토큰)+M3(Skills/Plugins) | `.claude/claude-plan.md` (M4~M5는 미착수) |
| code-server 익스텐션 추천/설치 (카테고리별 그룹핑 포함) | `.claude/extensions-plan-done.md` |
| 프로젝트 스캔/정리 1단계(용량/재생성 가능 폴더 탐지, 최근 편집 런처, 읽기 전용, mise 도구 표시 포함) | `.claude/projects-plan-done.md` (2단계 삭제는 미착수) |
| mise 관리(install/use/uninstall, 설치된 도구 목록, env 미리보기, 추천 목록) | `.claude/mise-plan-done.md` |
| 웹쉘(터미널) M1(임시 세션, xterm.js+PTY/WebSocket, 비밀번호 게이트 소급 적용됨) | `.claude/terminal-plan.md` (M2 named 영속 세션은 미착수) |
| 공용 비밀번호 게이트(`internal/authgate`, argon2id + ENV 전용 저장, 읽기 열림/쓰기 게이트 원칙으로 Git/SSH/Tailscale/Supervisor/Logs까지 확장) | `.claude/authgate-plan-done.md` |
| 파일 매니저(업로드/다운로드/이동/복사/이름변경/폴더생성/멀티선택/정보패널/텍스트편집, 자체 비밀번호 게이트) | `.claude/filemanager-plan-done.md` |
| 공용 코드 에디터(CodeMirror 6, 지연 로딩) — git raw 설정 편집/파일 매니저가 재사용 | 별도 문서 없음(공용 컴포넌트, `src/components/common/CodeEditor.tsx`) |
| Supervisor 로그 다이얼로그/바텀시트, 반응형 레이아웃(모바일 햄버거 사이드바), 로그 페이지네이션/시간범위 필터, CPU/메모리/디스크/네트워크 사용량 히스토리 그래프, 사이드바 드래그앤드롭 순서 변경(서버에 저장, `GET/PUT /api/ui/sidebar-order`), 탭 이름 영어로 통일(Code Extensions/Projects/Task Manager/Files) | 문서 없음(UI/관측성 개선, 각 기능 자체는 위 표의 해당 기능 문서 소관) |

전체 구현은 backend(Go)/frontend(React) subagent를 병렬로 여러 라운드 돌려서 진행,
각 라운드 사이 API 계약 불일치를 직접 대조해서 잡는 패턴 반복 — 새 기능도 이 방식
유지 권장(자세히는 `architecture-plan-done.md`).

**실제 컨테이너 검증**: 2026-08-02, `docker compose build && up`으로 전체 통합 확인
완료 (7개 supervisord program 전부 RUNNING, `docker compose logs` 라벨링 정상,
`/api/*` 전 엔드포인트 실응답 확인). 이후 `webmanager/review.md` 리뷰 라운드에서
나온 버그(critical 2건 포함)도 전부 수정 후 재검증 완료.

## 할 일 (우선순위 순, 문서 있으면 링크)

1. **Docker/dind 관리** — 미착수, **리서치는 완료**(CLI shell-out 방식/`run`·`exec`
   범위 제외/로그는 폴링으로 방향 확정, 열린 질문 1개는 `question.md`).
   `.claude/dind-plan.md`
2. **웹쉘(터미널) M2** — M1(임시 세션)과 비밀번호 게이트, 모바일 컨트롤/
   키바인딩/색상 테마는 구현 완료(위 "구현 완료" 표 참고). M2는 named 영속
   세션(탭 닫아도 유지, 이름으로 재접속 — tmux/screen 안 쓰고 webmanager가 PTY를
   직접 관리하는 방향으로 설계 근거만 마련됨). `.claude/terminal-plan.md`
3. **Claude Code 상태/관리 탭 M4~M5** — M1~M3는 구현 완료. 다음은 M4(익스텐션
   설치 배너, 이미 구현된 익스텐션 API 재사용 가능). `.claude/claude-plan.md`
4. **익스텐션 검색/URL 설치**(마켓플레이스 URL 붙여넣기 → open-vsx 교차 조회 →
   vsix 직접 설치 폴백) — 설계 완료, 미착수. `.claude/extension-search-plan.md`
5. **Light/Dark 수동 토글 + 사이드바 하단 상태 바** — 설계 완료, 미착수(착수 전
   기존 CSS 다크모드 구조부터 확인 필요). `.claude/theme-toggle-plan.md`
6. **Caddy 기반 dev 서버 expose** — mise보다도 후순위로 재조정됨. 설계는 대부분
   끝났지만(대부분의 결정 사항 확정) 남은 디테일(`preserve_host` 기본값 등)이 있어
   우선순위를 낮게 둠. `.claude/caddy-plan.md`
7. code-server 설정(settings.json 등) 편집 UI — 후순위, 타당성 재검토 필요(`ideas.md`)
8. tailscale 로그인 상태/URL을 webmanager UI에도 노출 — 아이디어 단계, 문서 없음
9. 바인드 주소 전략 확정 — **최후순위**
10. `/code/.vector/logs/*.jsonl` 보존기간(retention) 정책 없음 — 알려진 갭
    (`review.md` 참고), 문서 없음
11. code-docker 도움말/가이드를 webmanager에 임베드 — 아이디어 단계, 착수 전
    질문 정리 완료. `.claude/guide-plan.md`
12. **code-server/mise 버전 관리 패널** — **최하 우선순위**(guide-plan과 동급),
    아이디어 단계, 착수 전 질문 다수 정리 완료(특히 "컨테이너 리빌드 필요성"
    판단 기준이 근본적으로 불확실). `.claude/version-panel-plan.md`
13. 다국어(i18n) 지원, 아마 LinguiJS — 모든 기능이 안정되고 문자열이 안 바뀌기
    시작할 때 착수 예정, 아이디어 단계, 문서 없음.

## 참고 문서

- **API 정확한 스펙**: `webmanager/backend/README.md`, `webmanager/frontend/README.md`
  (구현된 그대로 최신 유지되는 원본)
- **기능별 설계/이력**: `webmanager/.claude/` (README로 인덱스)
- **아이디어 백로그**(아직 계획 문서 없는 브레인스토밍): `webmanager/ideas.md`
- **프로젝트 리뷰**: `webmanager/review.md`
- **저장소 소유자가 답해야 할 질문 전체 취합**: `.claude/question.md`
