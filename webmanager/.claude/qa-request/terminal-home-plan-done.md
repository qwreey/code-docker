# 터미널 홈 탭 — 구현 완료

## UI 개선 라운드 (2026-08-04, 저장소 소유자 실사용 피드백 반영)

1차 구현을 실제로 눌러본 뒤 받은 피드백 5가지 전부 반영:

- **데스크탑 가로 분할**: `.terminal-home`이 720px 이하(모바일, 기존 앱
  전역 브레이크포인트와 동일)에서는 기존처럼 세로로 쌓이고, 721px 이상에서는
  "열린 세션"/"프로파일" 두 판(`.terminal-home-pane`)이 좌우로 나란히 배치.
- **각 판 독립 스크롤**: 데스크탑 미디어쿼리에서만 `.terminal-home`이
  `overflow: hidden`이 되고 각 `.terminal-home-pane`이 자기 `overflow-y: auto`를
  가짐 — 한쪽이 길어도 다른 쪽 스크롤 위치에 영향 없음.
- **편집을 다이얼로그로**: 목록 맨 아래에 붙던 인라인 폼을 없애고, 기존
  공용 `Sheet`(모바일에서는 바텀시트로 자동 전환되는 컴포넌트,
  `FileEditorSheet.tsx`/`TerminalSettingsPanel.tsx`가 이미 쓰던 것과 동일)로
  교체 — 저장 버튼은 그 두 파일과 동일하게 `headerActions`에 배치.
- **카드형 프로파일 목록**: `.terminal-home-profile-list`를
  `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))`로 바꿔서
  판 너비에 따라 자동으로 여러 열 카드 그리드가 됨.
- **프로파일 드래그앤드롭 정렬**: `Layout/Sidebar.tsx`의 사이드바 탭 순서
  변경과 완전히 동일한 패턴(순수 HTML5 drag 이벤트, `dragIdRef`/`dragOverId`)을
  그대로 재사용 — 순서가 곧 `profiles` 배열 순서이고 `PUT
  /api/terminal/profiles`가 전체 배열을 그대로 replace하므로 백엔드 변경 없이
  프론트 재정렬 후 `onSaveProfiles(next)` 호출만으로 영속화됨.

`npm run build`/`npm run lint` 클린. 데스크탑 가로 분할은 헤드리스 브라우저로
`getBoundingClientRect` 직접 측정해서 두 판이 정확히 절반씩 나뉘고 각자 너비대로
렌더링되는 것까지 확인(스크린샷 캡처가 이 환경의 타일링 WM 때문에 실제 좁은
뷰포트로는 안 줄어들어서 모바일 폭 시각 확인은 못 함 — 모바일 스택 자체는
기존 로직 그대로라 별도 변경 없음). 다이얼로그/카드/드래그 정렬은 코드 검증까지만.

## 구현 완료 (2026-08-03)

아래 설계 그대로 전부 구현. 탭바 맨 앞에 항상 존재하는(닫기/이름변경/고정 불가)
"홈" 탭(`TerminalTabs.tsx`의 `HOME_TAB_ID` 상수)을 추가하고, Terminal 탭에
처음 들어왔을 때나 마지막 세션을 닫았을 때 기존 "열린 세션이 없습니다" 빈
화면 대신 이 홈 탭이 기본으로 뜨도록 바꿈. 홈 탭 안에는 (1) 현재 열려있는
세션 목록(클릭해서 전환, 고정/종료 버튼 재사용)과 (2) 이름 + 시작
위치(cwd)/실행할 명령을 저장해두는 "프로파일" CRUD 목록이 들어있음 — 프로파일을
누르면 그 값으로 새 세션이 열림.

백엔드: `internal/terminalprofiles`(라벨/cwd/command 전체 문서를
`terminalsettings`와 동일한 원자적 파일 저장 패턴으로 영속화) +
`handlers_terminal_profiles.go`(`GET/PUT /api/terminal/profiles`, 기존
터미널 라우트와 동일하게 게이트) 신규 추가. `internal/termsession`은
`newSession`/`Registry.GetOrCreate`가 `CreateOptions{Cwd, InitialCommand}`를
받도록 확장 — **세션이 실제로 새로 생성되는 시점에만** 적용되고(이미 떠있는
세션에 재연결(reattach)할 때는 무시), `Cwd`는 `os.Stat`으로 존재하는
디렉토리인지만 확인해서 유효하면 `cmd.Dir`로 쓰고 아니면 조용히 기존 기본값
(`/code`)으로 폴백(에러로 세션 생성 자체를 실패시키지 않음), `InitialCommand`는
셸이 뜬 직후 PTY에 그대로 `Write`(사용자가 직접 타이핑한 것과 동일 — 이미
전체 root 셸 접근을 주는 엔드포인트라 별도 이스케이프/검증 불필요, 자세한 근거는
`termsession.CreateOptions`의 doc comment 참고). `GET /api/terminal`
WebSocket의 named-session 경로(`?session=`)에 `cwd=`/`cmd=` 쿼리 파라미터를
추가해서 프론트가 세션을 처음 만드는 순간에만 실어 보냄 — 별도 REST
"세션 생성" 엔드포인트는 추가하지 않고 기존 "WS 연결이 곧 지연 생성" 패턴을
그대로 재사용.

프론트: `Terminal.tsx`의 `activeSession` 기본값/빈 상태 폴백을 `null`에서
`HOME_TAB_ID`로 교체, `addSession(opts?)`가 `{label, cwd, command}`를 받아
프로파일 라벨 기반 이름 채번(`nextSessionName`이 라벨을 우선 시도하고 충돌
시에만 "라벨 2", "라벨 3"...으로 폴백 — 기존 "세션 N" 채번과 별개 분기) +
`cwd`/`command`가 있으면 `pendingCreateOptionsRef`(WS 연결 이펙트가 그
세션 이름으로 접속하는 바로 그 순간에만 소비하고 지우는 Map ref)에 적재.
`TerminalHome.tsx`(신규) — 세션 목록/프로파일 CRUD UI, 프로파일 삭제는
기존 커스텀 테마 삭제(`TerminalSettingsPanel.tsx`)와 동일하게
`window.confirm` 필수. `example-env.webmanager`에
`WEBMANAGER_TERMINAL_PROFILES_PATH` 문서화 + `WEBMANAGER_ENV_VERSION` 4→5.

`go build`/`go vet`/`gofmt`/`go test ./...` (`envmigrate` 12개 테스트 포함,
버전 5로 올린 뒤에도 그대로 통과 — 그 테스트는 자체 픽스처를 쓰지
`example-env.webmanager` 실물을 안 읽음) + `npm run build`/`npm run lint`
전부 클린. **실컨테이너(`docker compose build && up`) 검증은 아직 안 함** —
특히 프로파일의 `cwd`/`InitialCommand`가 실제 셸에서 기대대로 동작하는지
(존재하지 않는 경로 폴백, 여러 줄 명령, 특수문자 포함 명령 등), 홈 탭
진입/세션 전환/탭 닫기 후 홈 복귀가 실제 브라우저에서 매끄러운지는 저장소
소유자가 직접 눌러봐야 확인 가능.

## 배경 / 아이디어 출처

저장소 소유자가 웹 터미널의 "열린 세션이 없습니다" 빈 화면을 보다가 떠올린
아이디어: 항상 열려있는(닫히지 않는) "홈" 탭을 맨 앞에 두고, 거기에 (1) 다른
탭들 목록과 (2) 원하는 위치에서 터미널을 열거나 스니펫을 실행하는 프로파일
목록을 두면 좋겠다는 제안. 난이도는 중간 — 프론트(홈 탭 UI, 프로파일
CRUD)와 백엔드(세션 생성 시 cwd/초기 명령 지원, 프로파일 영속화)를 모두
건드리지만 각각 기존 패턴(`internal/termsession` 레지스트리,
`internal/terminalsettings`류 백엔드 영속화)을 그대로 따라가는 수준이라
한 세션 안에서 완료.

## 설계 메모 (구현 그대로)

- **홈 탭은 가상 탭**: `internal/termsession.Session`이 절대 아니고,
  `TerminalSessionInfo[]`에도 안 들어감 — `TerminalTabs.tsx`가 세션 목록과
  별개로 항상 맨 앞에 렌더링. 이름변경/고정/종료 버튼이 아예 없음(세션이
  아니므로 대상이 없음).
- **cwd 검증은 보안 경계가 아니라 존재 확인**: 이 엔드포인트는 이미
  "webmanager에 닿을 수 있는 사람에게 root 셸을 여는" 기능이라(README/
  `handleTerminal`의 SECURITY 코멘트 참고) `cwd` 값 자체가 별도 공격 표면을
  넓히지 않음. `os.Stat` 검증은 오직 "존재하지 않는 경로를 줬을 때
  `exec.Command` 시작 자체가 실패해서 세션이 아예 안 열리는" 사용자 경험
  문제를 막기 위한 것.
- **초기 명령은 키 입력 그대로**: `ptmx.Write([]byte(command + "\n"))` —
  다른 `exec.Command`에 값으로 들어가는 게 아니라 이미 열린 인터랙티브 셸에
  타이핑하는 것과 완전히 동일한 경로라서 별도 이스케이프 불필요.
- **프로파일 이름 채번**: 프로파일 라벨이 있으면 그 라벨을 그대로 첫
  시도로 쓰고("블로그" → 있으면 "블로그 2"), 없으면(플러스 버튼으로 만든
  일반 세션) 기존 "세션 N" 규칙 그대로 — 두 채번 규칙이 `nextSessionName`
  하나의 함수 안에 공존.
- **프로파일 저장은 whole-document PUT**: `terminalsettings`와 동일하게
  부분 병합 로직 없음 — 프론트가 항상 전체 `profiles` 배열을 보냄.

## 확인 필요 (저장소 소유자)

- 별다른 이견 없으면 위 설계 그대로 유지. 실컨테이너에서 직접 테스트해보고
  프로파일 실행 시 cwd/command 동작, 홈 탭 UX(세션 목록/전환/탭 닫기 후 복귀)
  전반을 확인해주면 됨.
