# 확인/결정 필요 목록 (전체 취합, 2026-08-02 최신)

`attention-needed.md`를 대체함(중복 방지를 위해 이 문서로 흡수 후 삭제) —
`feedback/feedback-2026-08-02.md`(실사용 피드백 라운드)와 그 전 라운드의 "사용자 확인
필요" 항목을 전부 여기 한 곳에 모음. **막고 있는 항목은 없음** — 전부 합리적
기본값으로 진행 중이거나 이미 그 기본값대로 구현 완료됨. 급한 것부터 정렬하지
않고 주제별로 묶었으니 천천히 훑어보고 마음에 안 드는 것만 답하면 됨.

## 지금 바로 결정하면 유용한 것 (작지만 실사용에 영향)

- ~~비밀번호 게이트 해시 계산 CLI 헬퍼가 없음~~ — **해결됨(2026-08-03)**:
  `webmanager --hash-password`(새 서브커맨드, 별도 바이너리/빌드 타겟
  아니라 기존 webmanager 바이너리를 재사용 — `hashpassword.go`)가
  `docker compose exec code-docker /etc/code-docker/webmanager/webmanager
  --hash-password`로 바로 실행 가능. 비밀번호 두 번 입력(오타 확인, 화면에
  안 보임 — TTY일 때만, 파이프 입력이면 한 줄만 읽음)받아 argon2id 해시
  한 줄만 stdout에 출력. `README.md`(사용자 문서)와 `docker-compose.yml`의
  `WEBMANAGER_AUTH_PASSWORD_HASH` 주석에 인라인으로 문서화됨(다른 `.md`
  참조 없이 그 자리에서 바로 따라할 수 있게).
- **비밀번호 게이트 미설정 상태**: 지금 `WEBMANAGER_AUTH_PASSWORD_HASH`가
  설정 안 돼 있으면 Terminal/파일 매니저/Logs/각종 쓰기 액션 전부 그냥 열려
  있음(기존 신뢰 모델 그대로) — 위 CLI 헬퍼가 이제 있으니 설정 자체는
  더 이상 막혀있지 않음.
- **`WEBMANAGER_FILES_ROOT` 기본값이 `/code`로 좁혀져 있음** — 컨테이너 전체
  (`/etc`, `/usr` 등)까지 파일 매니저로 브라우징하고 싶으면 이 값을 `/`로
  바꿔야 함. 지금은 "루트 폴더를 code-server 밖에서 만지고 싶다"는 원래
  요청보다 보수적으로 좁혀서 시작함(안전한 기본값 우선).

## 구현하면서 기본값으로 처리한 것 (원하면 언제든 조정 가능)

**mise** (완료): Projects 탭엔 mise CRUD 버튼 없이 읽기 전용만, 삭제 시
"config에서도 제거" 체크박스 기본 해제, 진행 상황은 폴링 방식,
`WEBMANAGER_MISE_BINPATH` 추가함.

**파일 매니저** (완료): 업로드 상한 `WEBMANAGER_FILES_MAX_UPLOAD_BYTES` 기본
2GiB, 디렉토리 zip 다운로드는 범위 밖(파일 단위만, 나중에 `archive/zip`으로
저비용 추가 가능), 생성 시각 못 읽으면 "정확한 생성 시각 아님" 라벨과 함께
변경 시각으로 대체 표시.

**비밀번호 게이트 적용 범위** (완료): 읽기는 열림/쓰기만 게이트가 원칙, 예외로
터미널·파일 매니저·Logs(전체)·Supervisor 로그 조회는 통째로 게이트. extensions/
mise의 설치·삭제(쓰기)는 이번 라운드에 게이트 **안 함**(사용자가 명시적으로
언급 안 한 범위) — 필요하면 알려줘, 저비용으로 추가 가능. 전체 목록은
`.claude/authgate-plan-done.md`.

## 아직 구현 안 된 것 — 계획 문서만 존재 (착수 전 결정 필요한 질문 포함)

- **가이드/도움말 임베드** (`.claude/research/guide-plan.md`) — 작명, 문서 파일 위치
  (build-time 임베드 vs 런타임 로드), override 가능 여부, 마크다운 렌더링
  방식(라이브러리 vs 직접 파싱), 이미지 관례, 탭 내비게이션 구조, 분할 작업을
  누가 할지, 검색 필요 여부 — 8개 질문 정리됨.
- **버전 관리 패널** (`.claude/research/version-panel-plan.md`, 우선순위 최하) —
  **핵심적으로 불확실한 질문 하나**: "컨테이너 리빌드가 필요하다"를 뭘 기준으로
  판단할지(Arch 베이스 이미지 변경? pacman 패키지 상태? 후자는 빌드 캐시 때문에
  신뢰하기 애매함 — 사용자 본인도 확신 없다고 밝힘). 그 외
  `code-server-autoinstall` 서브모듈 업데이트 판단 기준, 확인 주기. **참고**:
  code-server 바이너리 자체는 이미 매 재시작마다 자동 업데이트되고 있어서(설치
  스크립트가 GitHub 최신 릴리즈를 확인) git pull이 필요한 문제가 아니고,
  webmanager가 자기 자신이 담긴 컨테이너를 리빌드할 방법 자체가 없어서 이 패널이
  할 수 있는 최대치는 "알림"까지임.
- **dind 관리** (`.claude/dind-plan.md`, 리서치만 완료) — `docker inspect`
  상세 뷰(컨테이너 환경변수 통째로 노출 가능)를 v1에 포함할지만 답하면 나머지
  (CLI shell-out, run/exec 제외, 로그는 폴링)는 리서치로 결론 나서 바로 착수
  가능.
- **익스텐션 검색/URL 설치** (`.claude/extension-search-plan.md`) —
  검색 설치는 마일스톤(급하지 않음). URL 붙여넣기 설치(마소 마켓플레이스 → 
  open-vsx 교차 조회 → 없으면 안내 → vsix 직접 설치 폴백 물어보기)가 더
  중요한 요청으로 기록됨, API 설계까지 초안 있음. (익스텐션 "더 보기" 정보
  링크와 삭제(uninstall)는 이미 구현 완료 — `.claude/archive/extensions-plan-done.md`
  참고. mise 쪽 "더 보기" 링크는 `mise registry --json`이 홈페이지 필드를
  주는지부터 확인 필요, `.claude/qa-request/mise-plan-done.md` 참고.)
- **caddy** (`.claude/research/caddy-plan.md`, 우선순위 낮음) — 유일하게 남은 디테일
  (`preserve_host` 기본값)은 급하지 않다고 이미 정리됨. Monaco 도입 고민은
  이제 공용 `CodeEditor`(CodeMirror 6)로 해소돼서 더 이상 열린 질문 아님.
- **code-server 안에서 매니저 여는 방법** (`.claude/qa-request/expose-plan-done.md`의
  "나중 마일스톤" 절 — `/manager` 경로 통합 자체는 구현 완료, 실컨테이너 QA만
  남음) — 4개 질문:
  트리거(커맨드 팔레트/사이드바 아이콘/키바인딩?), 표시 형태(작은
  위젯(iframe) vs 전체 화면 네비게이션 vs 둘 다?), PWA `shortcuts`
  필드(code-server manifest를 새로 패치해야 함, 홈 화면 꾹 눌러서 뭘
  보여줄지?). 긴 세션을 폰으로 여는 건 이 마일스톤과 무관하게 `/manager`
  경로만 생기면 이미 해결됨(오해 방지 기록).

## 탭 이름 영어 통일 (2026-08-02 QoL 패치)

사이드바 탭 이름을 전부 영어로 통일함(`익스텐션`→"Code Extensions",
`프로젝트`→"Projects", `작업 관리자`→"Task Manager", `파일`→"Files") — 이미
영어였던 것(Supervisor, SSH Keys, Git Config, Tailscale, Logs, Claude Code,
Terminal, mise)과 일관성 맞춤. **탭 이름/`<h1>` 제목만** 바꿨고, 각 탭 안의
설명 문구/버튼 라벨 등은 여전히 한국어 — 전체 UI를 한쪽 언어로 통일하는 건
범위 밖(사용자가 향후 LinguiJS 도입은 "모든 기능 완성 후"로 명시적으로 미룸).
**사용자가 직접 제기한 질문**: 나중에 i18n(다국어) 도입 시, 이 영어 탭 이름들을
번역 대상 문자열로 취급할지("Code Extensions"를 다른 언어로도 번역), 아니면
고유명사 취급해서 항상 영어 고정으로 둘지 — 지금 결정 안 해도 됨, LinguiJS
도입 시점에 다시 판단.

## 알려진 사소한 개선 여지 (급하지 않음, 답 안 해도 됨)

- Logs 실시간 모드가 "이 시각 이후만" 서버 커서 대신 클라이언트 필터로 신규
  항목을 걸러냄(정확한 서버 커서가 더 효율적이지만 지금도 정상 동작).
- CPU 코어별 히트맵에 마우스 올렸을 때 "그 코어의 최근 히스토리 그래프"는
  아직 없음(순간값만 표시) — 백엔드는 이미 `points[].hostPerCorePercent`로
  코어별 시계열을 제공하고 있어서 프론트만 붙이면 됨.
- **webmanager 프론트 번들 크기 경고**: `npm run build`가 "청크 500KB 초과"
  경고를 계속 냄(CodeMirror/xterm.js는 이미 지연 로딩으로 분리됨, 주 번들
  자체가 기능이 늘면서 커짐). 에러 아니고 기능 지장도 없음 — 계속 커지면 탭
  단위 `React.lazy` 확대를 고려할 시점이 옴.
- `/code/.vector/logs/*.jsonl` 보존기간(retention) 정책 없음 — 계속 쌓이기만
  함, 오래전부터 알려진 갭.

## 검증 관련

- **실컨테이너 통합 검증**: 이번 세션에 추가/변경된 모든 기능이
  `go build`/`go vet`/`npm run build`/`npm run lint` + 가능한 범위의 로컬
  스모크 테스트는 통과했지만, `docker compose build && up`으로 실컨테이너에서
  전체를 확인한 적은 없음 — 사용자가 직접 그 작업을 진행 중인 것으로 앎, 문제
  발견되면 바로 대응.
