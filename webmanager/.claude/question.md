# 확인/결정 필요 목록 (전체 취합, 2026-08-05 정리)

`attention-needed.md`를 대체함(중복 방지를 위해 이 문서로 흡수 후 삭제) —
`feedback/feedback-2026-08-02.md`(실사용 피드백 라운드)와 그 전 라운드의 "사용자 확인
필요" 항목을 전부 여기 한 곳에 모음. **막고 있는 항목은 없음** — 전부 합리적
기본값으로 진행 중이거나 이미 그 기본값대로 구현 완료됨. 급한 것부터 정렬하지
않고 주제별로 묶었으니 천천히 훑어보고 마음에 안 드는 것만 답하면 됨.

## 지금 바로 결정하면 유용한 것 (작지만 실사용에 영향)

- **비밀번호 게이트 미설정 상태**: 지금 `WEBMANAGER_AUTH_PASSWORD_HASH`가
  설정 안 돼 있으면 Terminal/파일 매니저/Logs/각종 쓰기 액션 전부 그냥 열려
  있음(기존 신뢰 모델 그대로) — `webmanager --hash-password` CLI 헬퍼가
  있으니 설정 자체는 막혀있지 않음(`archive/authgate-plan-done.md` 참고).
- **`WEBMANAGER_FILES_ROOT` 기본값이 `/code`로 좁혀져 있음** — 컨테이너 전체
  (`/etc`, `/usr` 등)까지 파일 매니저로 브라우징하고 싶으면 이 값을 `/`로
  바꿔야 함. 지금은 "루트 폴더를 code-server 밖에서 만지고 싶다"는 원래
  요청보다 보수적으로 좁혀서 시작함(안전한 기본값 우선).

## 구현하면서 기본값으로 처리한 것 (원하면 언제든 조정 가능)

**mise** (완료): Projects 탭엔 mise CRUD 버튼 없이 읽기 전용만, 삭제 시
"config에서도 제거" 체크박스 기본 해제, 진행 상황은 폴링 방식,
`WEBMANAGER_MISE_BINPATH` 추가함.

**mise 도구 검색/버전 선택** (완료, `.claude/archive/mise-search-plan-done.md`):
검색어 최소 2글자(미만이면 API 호출 없이 안내만), registry 캐시는 파일
아닌 인메모리 TTL(6시간) — 버전 목록(`ls-remote`)은 캐시 없이 매번 조회,
버전 목록 UI는 콤보박스 대신 스크롤+필터, 설치 시작 후에는 검색
다이얼로그를 닫고 mise 탭의 모든 job 액션(추천 설치 포함)이 공유하는
하나의 top-level 진행 다이얼로그로 통일 — 전부 사용자가 이번 요청에서
직접 결정.

**파일 매니저** (완료): 업로드 상한 `WEBMANAGER_FILES_MAX_UPLOAD_BYTES` 기본
2GiB, 디렉토리 zip 다운로드는 범위 밖(파일 단위만, 나중에 `archive/zip`으로
저비용 추가 가능), 생성 시각 못 읽으면 "정확한 생성 시각 아님" 라벨과 함께
변경 시각으로 대체 표시.

**비밀번호 게이트 적용 범위** (완료): 읽기는 열림/쓰기만 게이트가 원칙, 예외로
터미널·파일 매니저·Logs(전체)·Supervisor 로그 조회는 통째로 게이트.
extensions/mise의 설치·삭제(쓰기)와 프로세스 시그널 전송도 보안 감사
(`.claude/code-docker-sec.md`)로 누락이 발견돼 2026-08-05에 게이트 추가함.
전체 목록은 `.claude/archive/authgate-plan-done.md`.

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
- **익스텐션 검색/URL 설치** (`.claude/extension-search-plan.md`) —
  검색 설치는 마일스톤(급하지 않음). URL 붙여넣기 설치(마소 마켓플레이스 → 
  open-vsx 교차 조회 → 없으면 안내 → vsix 직접 설치 폴백 물어보기)가 더
  중요한 요청으로 기록됨, API 설계까지 초안 있음. (익스텐션 "더 보기" 정보
  링크와 삭제(uninstall)는 이미 구현 완료 — `.claude/archive/extensions-plan-done.md`
  참고. mise 쪽 "더 보기" 링크는 `mise registry --json`이 홈페이지 필드를
  주는지부터 확인 필요, `.claude/archive/mise-plan-done.md` 참고.)

**caddy(Dev Proxy)와 "code-server 안에서 매니저 여는 방법"은 둘 다 구현
완료돼서 이 목록에서 빠짐** — caddy는 `.claude/qa-request/caddy-plan-done.md`
(`preserve_host` 기본값도 "없음"으로 확정됨), 매니저 여는 방법은 위젯 버튼
(`.window-appicon` 클릭 → iframe 오버레이)과 PWA `shortcuts` 점프리스트
항목 둘 다 구현됨(`.claude/archive/expose-plan-done.md`,
`.claude/archive/manifest-shortcuts-plan-done.md`) — 남은 건 실컨테이너 QA뿐.

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
- **webmanager 프론트 번들 크기 경고**: `npm run build`가 "청크 500KB 초과"
  경고를 계속 냄(CodeMirror/xterm.js는 이미 지연 로딩으로 분리됨, 주 번들
  자체가 기능이 늘면서 커짐). 에러 아니고 기능 지장도 없음 — 계속 커지면 탭
  단위 `React.lazy` 확대를 고려할 시점이 옴.
- `/code/.local/share/code-docker/vector/logs/*.jsonl` 보존기간(retention)
  정책 없음 — 계속 쌓이기만 함, 오래전부터 알려진 갭.

## 검증 관련

- **실컨테이너 통합 검증**: 이번 세션에 추가/변경된 모든 기능이
  `go build`/`go vet`/`npm run build`/`npm run lint` + 가능한 범위의 로컬
  스모크 테스트는 통과했지만, `docker compose build && up`으로 실컨테이너에서
  전체를 확인한 적은 없음 — 사용자가 직접 그 작업을 진행 중인 것으로 앎, 문제
  발견되면 바로 대응.


## 2026-09-06 배치(사용자 노트 8건)에서 남은 결정

전부 "지금 합리적 기본값으로 돌아가고 있고, 마음에 안 드는 것만 답하면 되는" 것들.

1. **모바일 입력 방식 기본값.** 지금 `diff`(새 입력 필드)가 기본이다. 다만 예전
   워크어라운드를 **명시적으로 껐던** 기기는 그 의사를 존중해 `native`(끔)로
   마이그레이션된다 — 즉 그 기기는 설정에서 한 번 바꿔줘야 새 방식을 쓴다.
   그냥 전부 `diff`로 밀어버릴지, 지금처럼 존중할지.
2. **터치 모드 선택기 위치.** 지금은 터미널 헤더(상단, "설정" 옆)다. 레포 루트
   `TODO.md`에 "키보드 모드키 위치는 모바일에서 키보드 바로 위(아래쪽)가 좋아
   보인다"는 사용자 메모가 이미 있는데, 그 논의는 하단 컨트롤 바에 대한 것이었다.
   터치 모드 선택기도 같이 아래로 내릴지, 상단에 둘지.
3. **터치 모드 기본값.** 지금 `scroll`(기존 동작). 실사용에서 `마우스`를 훨씬 더
   많이 쓴다면 기본값을 바꿀 수 있다.
4. **터미널 탭에서만 앱 상단 바를 숨기는 것.** 세로 3.6rem을 벌지만, 터미널 탭에서
   "webmanager" 제목이 사라지고 햄버거 위치가 다른 탭과 달라진다. 이 비대칭이
   괜찮은지.
5. **파일 에디터 줄바꿈 기본값.** 지금 켬. 폰 기준으로는 맞다고 봤는데 데스크탑에서
   코드 편집이 주 용도라면 반대일 수 있다(기기별 저장이라 한 번 끄면 그 기기는
   계속 꺼진 상태로 남는다).
6. **VNC kick 창 15초.** noVNC 자동 재연결을 실제로 막는 건 확인했지만 길이 자체는
   판단값이다. `router/backend/handlers_vnc.go`의 `vncKickWindow` 한 줄.
7. **VNC 네이티브 클라이언트 가시성.** 지금은 router를 거친 연결만 보이고 UI에도
   그렇게 적어뒀다. 진짜 전체 목록은 `wayvncctl` 연동이 필요하고 그건 별도 작업
   (`.claude/archive/vnc-connected-clients-plan-done.md`의 마지막 절).
8. **핀치 줌을 실제로 구현할지, iOS도 대상인지.**
   `webmanager/.claude/terminal-pinch-zoom-plan.md` — 안드로이드만이면 그대로 되고,
   iOS도 넣으려면 비표준 `gesturestart`/`gesturechange` 분기가 따로 필요하다.
9. **탭바를 가로 스크롤로 바꿀지.** `research/terminal-control-bar-plan.md`가
   "안 한 것"으로 남겨둔 유일한 항목이고, 예전부터 사용자 결정 대기 중이다.
10. **authgate per-IP 백오프의 전역 버킷 문제를 고칠지.**
    `.claude/backlog/authgate-client-ip-blind-spot.md` — 이번에 VNC 쪽만
    `realClientIP()`로 고쳤고 인증 백오프는 일부러 안 건드렸다.
