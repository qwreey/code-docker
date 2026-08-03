# 웹쉘(터미널) — 구현 완료 (M1+M2, 모바일 레이아웃, 인증 전부 끝)

## 업데이트 (2026-08-03, 여섯 번째 라운드): 실사용 버그 2건 + 아이콘 + 빈 상태

- **Ctrl+D로 셸이 끝나도 세션이 안 닫히던 버그 — 수정**: `Session.pump()`가
  PTY EOF를 감지하고 `Close()`는 호출했지만, (1) `Registry.sessions` 맵에서
  안 지워짐(닫힌 세션이 탭 목록에 좀비로 계속 보임), (2) 붙어있던 WebSocket
  연결도 아무도 안 끊어서 클라이언트 input을 기다리며 그냥 걸려있었음(서버가
  먼저 알려주는 게 없어서). `Session.Done()`(닫힐 때 정확히 한 번 close되는
  채널) 추가 → `Registry.GetOrCreate`가 세션 생성 시점에 감시 고루틴을 하나
  띄워서 `Done()` 신호를 받으면 맵에서 제거(`forgetWhenDone`, 포인터 동일성
  체크로 이름 재사용 레이스 방지) → `handleNamedTerminal`도 같은 신호를
  구독해서 받으면 자기 컨텍스트를 취소(`cancel()`), 그러면 블로킹 중이던
  `conn.Read`가 풀려서 연결이 실제로 닫힘. 프론트도 `ws.onclose`에서
  `refreshSessions()`를 추가로 호출해서 탭 목록이 바로 갱신되게 함.
- **Ctrl+W — 브라우저 탭 vs PWA 창 차이 확인됨**: 사용자가 실제로 VS Code/
  Termix로 직접 확인 — 일반 브라우저 탭에서는 OS/브라우저가 그 조합키를 아예
  페이지로 안 보내서 못 막지만(코드 변경 불가능한 영역), **PWA로 설치해서 연
  창에서는 브라우저가 그 조합키를 가로채지 않아서 `preventDefault()` +
  `return true`(xterm이 계속 처리해서 셸로 정상 전달)가 실제로 먹힘**. 코드는
  이미 정확히 이 동작이었음(수정 불필요), 주석만 이 사실 반영하도록 갱신.
  webmanager를 PWA로 설치하는 건 사람이 할 일로 `TODO.md`에 등록됨(다른
  `expose.md`의 code-server 통합 라우트 계획과도 연결).
- **마지막 세션 닫으면 "세션 1"이 새로 안 생기고 빈 화면** — `closeSession`이
  남은 세션이 0개면 `activeSession`을 `null`로(예전엔 새 이름을 만들어서 바로
  재연결했음). `null`이면 WS 연결 자체를 안 열고, `.terminal-empty-state`
  ("열린 세션이 없습니다." + "세션 열기" 버튼)를 보여줌. xterm 인스턴스는
  안 없애고 `hidden` 속성으로만 숨김(마운트 유지 — 세션이 다시 생겨도 xterm을
  새로 만들 필요 없게). 초기 마운트 시 첫 기본 세션("세션 1")은 그대로 자동
  생성됨 — `null`은 오직 사용자가 명시적으로 마지막 탭을 닫았을 때만 도달.
- **Lucide Icons 도입**(`lucide-react` 새 의존성) — 탭 핀(📌 이모지 →
  `Pin`/`PinOff`, 고정 여부에 따라 다른 아이콘), 탭 닫기(`X`), 새 세션(`Plus`),
  사이드바 잠금 상태(`Lock`/`LockOpen`), 테마 토글(`Monitor`/`Sun`/`Moon`) —
  `theme-toggle-plan-done.md`에도 관련.

`go build`/`go vet`/`gofmt`, `npm run build`/`npm run lint` 클린. 세션
close/reopen 플로우와 테마 토글은 헤드리스 브라우저로 직접 확인(DELETE
응답은 실백엔드가 없어서 `window.fetch`를 임시로 몹업해서 검증). Ctrl+D
PID-death 감지 로직 자체는 이전 라운드와 동일한 이유로 이 개발 호스트에서
실행 검증 불가(`cmd.Dir = "/code"`가 컨테이너 전용) — 코드 리뷰로 대신,
**실컨테이너에서 한 번 확인 권장**.

**이 문서는 끝난 기능임 — 재설계/재구현 필요 없음.** 아래는 다음에 이 기능을
만질 사람(에이전트 포함)을 위한 최종 아키텍처 요약 + 왜 이렇게 됐는지의 근거만
남긴 정리본. 라운드별 원본 작업 로그는 필요하면 git log(`webmanager/backend/
handlers_terminal.go`, `internal/termsession/`, `webmanager/frontend/src/
components/Terminal/`)로 추적 가능 — 이 문서엔 더 이상 안 남김.

## 최종 아키텍처

**백엔드** (`handlers_terminal.go` + `internal/termsession/`):
- `GET /api/terminal` — WebSocket 업그레이드. `?session=<name>` 없으면 M1
  경로(매 연결마다 새 PTY, 연결 끊기면 즉시 SIGHUP→유예→SIGKILL로 종료) —
  최초 구현 그대로 유지, M2가 회귀시키지 않도록 의도적으로 별도 코드 경로.
  `?session=<name>` 있으면 M2 경로: `internal/termsession.Registry`가
  이름→`Session` 맵을 관리, 처음 보는 이름이면 새 PTY 생성, 이미 있으면
  재부착. `Session.pump()` 고루틴이 세션 생성부터 종료까지 PTY를 계속 읽어서
  스크롤백 링 버퍼에 쌓고 클라이언트가 붙어있으면 동시에 흘려보냄 — PTY
  생명주기가 WebSocket 연결과 완전히 분리됨(tmux/screen 안 씀, 사용자가
  "버그 많음"이라 명시적으로 배제 — webmanager가 PTY를 직접 관리).
  재접속 시 스크롤백부터 재생 후 실시간 전환. 동시 접속은 last-wins(새 연결이
  이전 걸 자동으로 끊음, `sinkGen` 세대 카운터로 레이스 방지).
- `GET /api/terminal/sessions`(목록) / `PATCH .../sessions/{name}`
  (`{pinned}` 토글) / `DELETE .../sessions/{name}`(즉시 종료) — "임시"와
  "영속"은 같은 PTY 관리 코드 경로이고 차이는 `pinned` 플래그 하나뿐(이름은
  세션 자체가 항상 갖고 있음) — 그래서 세션 생성 시점에 영속 여부를 정할
  필요가 없고, 아무 때나 토글 가능. 유휴 GC(`Registry.Run`, 1분 주기)는
  `pinned`이거나 현재 붙은 클라이언트가 있으면 절대 안 건드리고, 그 외엔
  `WEBMANAGER_TERMINAL_SESSION_IDLE_TIMEOUT`(기본 30분) 지나면 정리.
  컨테이너 재시작하면 pinned 여부와 무관하게 전부 사라짐(의도된 제약 —
  재부팅까지 버티게 할 생각 없음, 필요하면 세션 안에서 직접 tmux/screen 쓰면
  됨).
- 인증: `internal/authgate.RequirePassword`로 게이트(터미널 + 파일 매니저가
  공유하는 단일 게이트, `WEBMANAGER_AUTH_PASSWORD_HASH` env var). 해시는
  `argon2id`(이미 있던 `golang.org/x/crypto` 의존성 재사용), ENV로만 주입
  (설정 파일 저장 금지 — 컨테이너 안에서 우회 못 하게), `/etc/environment`
  교차 검증으로 변조 방지. **해시 계산은 `webmanager --hash-password` CLI로**
  (`hashpassword.go`, `docker-compose.yml`의 `WEBMANAGER_AUTH_PASSWORD_HASH`
  주석에 실행법 인라인 문서화됨) — 예전엔 이게 없어서 스니펫을 직접 짜야
  했는데 지금은 해결됨.
- 알려진 한계: 터미널 탭 자체(`GET /api/terminal` WS 업그레이드)는
  `RequiresUnlock`으로 안 감싸져 있음 — 게이트에 막히면 조용히 실패(에러 UI
  없음). 설정 API(`/api/terminal/settings`)는 전역 401 인터셉터 혜택을 받아
  정상 동작.

**프론트** (`src/components/Terminal/`):
- xterm.js(`@xterm/xterm` + `@xterm/addon-fit`) — 이 저장소가 다른 곳(차트)
  에서는 새 UI 라이브러리를 안 들이는 원칙이지만, 터미널 에뮬레이션은 예외로
  채택(ttyd/gotty 등 동종 프로젝트의 사실상 표준). xterm.js 인스턴스는
  마운트 시 한 번만 생성(탭 전환마다 재생성 안 함) — WebSocket 연결만
  `activeSession`이 바뀔 때마다 새로 열림(`?session=` 쿼리), 전환 시
  `term.reset()`으로 화면 비우고 서버가 재생하는 스크롤백으로 다시 채움.
- `TerminalTabs.tsx` — VSCode 스타일 세션 탭(`GET /api/terminal/sessions`
  기반, 목업 아님): 탭 클릭(전환), 📌(유지 토글), ×(종료), +(새 세션 —
  "세션 N" 자동 넘버링, `nextSessionName`이 현재 활성 세션 이름도 제외 대상에
  포함하도록 수정됨 — 안 그러면 목록이 아직 최신이 아닐 때 "+"를 눌러도 같은
  이름이 다시 골라져서 아무 일도 안 일어나는 것처럼 보이는 버그가 있었음,
  실브라우저 테스트로 발견/수정). 세션 생성은 별도 API 호출 없이 그냥 새
  이름으로 WebSocket을 여는 것 자체가 트리거(`GetOrCreate`가 처리).
- 키바인딩/색상 테마 — `GET/PUT /api/terminal/settings`
  (`internal/terminalsettings`, 원자적 저장, 비밀번호 게이트). 모바일 온스크린
  컨트롤 바(Esc/Ctrl/Alt/Shift/Tab/방향키, Ctrl/Alt/Shift는 sticky modifier).
  색상 테마 10개 프리셋(Dracula/Solarized/Monokai/Nord/Gruvbox/One Dark/
  Tomorrow Night/Ayu/GitHub Light, `themes.ts`에 하드코딩, 백엔드 저장 안 함)
  + 사용자 정의 테마(백엔드 `customThemes`에 저장, 프리셋은 편집 불가).
  **터미널 색상은 앱 전체 라이트/다크 테마(`theme-toggle-plan-done.md`)와
  독립** — xterm 테마가 곧 터미널의 색상이고, `--term-bg`/`--term-fg`로
  `Terminal.css`의 `.terminal-surface`/`.terminal-key-btn`(`color-mix`로
  블렌딩)/`.xterm-viewport`(xterm 자체 CSS의 하드코딩 `#000`을 `!important`로
  덮어씀)가 전부 그 색을 따라감 — 어떤 프리셋을 골라도 컨트롤 바가 항상
  터미널과 동화됨.
- 모바일 키보드 대응(`useKeyboardInset.ts`) — **핵심 사실**: iOS Safari와
  Android Chrome(108+) 둘 다 온스크린 키보드가 떠도 CSS 레이아웃 뷰포트
  자체를 안 줄임(visual viewport만 줄어듦) — `dvh`만으론 절대 안 풀리는
  문제(서브에이전트 리서치로 확인). `window.visualViewport`의 `resize`/
  `scroll` 이벤트를 구독해서 키보드가 가린 픽셀 수를 계산, `--kb-inset` CSS
  커스텀 프로퍼티로 얹어서 `.terminal-section`의 `height: calc(100dvh - Xrem
  - var(--kb-inset, 0px))`에 반영 — 섹션 자체가 줄어들면 flex column의 마지막
  자식(모드키 바)이 자연스럽게 키보드 바로 위에 위치. `index.html`에
  `interactive-widget=resizes-content`도 추가(Chrome/Firefox 한정 보너스,
  Safari는 이 메타값 자체를 미지원 — WebKit 버그 259770, 2026년 6월까지도
  미해결). **실제 모바일 기기에서 사용자가 검증 완료**(키보드 크기 정확히
  추적).
- 엣지투엣지 레이아웃 — `.terminal-section`이 `.app-content`의 패딩만큼
  음수 마진(활성 시 `.app-content`의 유일한 자식이라 형제 레이아웃 안전).
  모드키 바와 터미널을 `.terminal-surface` 하나로 병합(border/gap 없이 한
  표면처럼).
- Ctrl+W로 탭이 닫히는 문제: **근본적으로 해결 불가능** — Chrome은 브라우저
  UI에 바인딩된 조합키(Ctrl+W/N/T/Tab 등)는 keydown 이벤트 자체를 페이지 JS로
  안 보냄(Windows 기준 확인) — `preventDefault()`를 걸 대상 이벤트가 애초에
  안 옴. 전용 Chrome 확장(`xterm-ctrl-w-capture`)이 따로 존재할 정도로 페이지
  JS만으론 안 됨. `term.attachCustomKeyEventHandler`로 최선 시도는 넣어뒀지만
  (막히지 않는 브라우저/플랫폼에서는 도움 될 수 있음), 근본 해결책은 브라우저
  확장 설치뿐 — 이 이상 시도하지 말 것.

## 알려진 남은 갭 (재작업 목록 아님, 참고용)

- 터미널 탭 자체가 `RequiresUnlock`으로 안 감싸져 있음(위 참고).
- 실컨테이너에서 PTY 생성→attach→detach→재attach 스크롤백 재생 전체 플로우,
  유휴 세션 자동 정리, 여러 탭 동시 연결이 각기 다른 세션에 정말 붙는지는
  개발 호스트에서 검증 불가했음(`cmd.Dir = "/code"`가 컨테이너 전용 경로라).
  로직은 코드 리뷰 + 부분 유닛 테스트(링 버퍼)로 검증, 실컨테이너 확인 권장.
