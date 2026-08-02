# 웹쉘(터미널) (M1 구현 완료, M2/인증은 나중)

## 구현 완료 (2026-08-02): M1

`github.com/creack/pty` + `github.com/coder/websocket`로 `GET /api/terminal` 구현.
`/etc/passwd`의 root 쉘(빌드 시 `chsh`로 이미 확정)을 그대로 spawn, 바이너리
WS 프레임 = PTY 입출력, 텍스트 WS 프레임 = `{"type":"resize",...}` 리사이즈 제어.
프론트는 `@xterm/xterm` + `@xterm/addon-fit`으로 `src/components/Terminal/` 신설,
`ResizeObserver`로 리사이즈 감지. 인증 없음(webmanager 기존 신뢰 모델 그대로,
아래 "인증" 절 방향대로). 연결 종료 시 PTY 프로세스 확실히 정리(SIGHUP → 유예 →
SIGKILL, `cmd.Wait()`로 좀비 방지) — 실제 서버 기동 + WS 클라이언트로 명령 실행/
비정상 종료 양쪽 다 스모크 테스트 완료(좀비 프로세스 없음 확인).
`go build`/`go vet`/`gofmt`, `npm run build`/`npm run lint` 전부 클린.

## 업데이트 (2026-08-02, 두 번째 라운드): 모바일 컨트롤 + 키바인딩/테마 — 구현 완료

- **모바일 온스크린 컨트롤 바**: Esc/Ctrl/Alt/Shift/Tab/방향키 버튼을 터미널
  위에 항상 표시(키보드 유무 감지는 안 함 — "일단 바로 띄우자"는 사용자 결정).
  Ctrl/Alt/Shift는 sticky modifier로 동작(눌러서 "무장"하면 다음 입력 1회에
  적용 후 해제) — `src/components/Terminal/{TerminalControls.tsx,modifiers.ts}`.
- **키바인딩 커스터마이징**: `GET/PUT /api/terminal/settings`(백엔드
  `internal/terminalsettings`, `/code/.webmanager/terminal-settings.json`에
  원자적 저장, **비밀번호 게이트 적용**) — 라벨/전송 바이트를 웹에서 직접 편집,
  기본값은 위 컨트롤 바와 동일 키.
- **색상 테마**: xterm.js `theme` 옵션으로 구현(원래 궁금했던 "가능한지"는
  확인 완료 — xterm.js 표준 기능이라 어렵지 않음). **프리셋 10개**(Dracula,
  Solarized Dark/Light, Monokai, Nord, Gruvbox Dark, One Dark, Tomorrow Night,
  Ayu Dark, GitHub Light, `src/components/Terminal/themes.ts`에 하드코딩,
  백엔드엔 저장 안 함) + **사용자 정의 테마**(색상 피커로 직접 편집, 백엔드
  `customThemes`에 저장) — **프리셋은 편집 불가**, 커스텀 테마만 수정/삭제
  가능.
- **알려진 한계**: 터미널 탭 자체는 `RequiresUnlock`으로 안 감싸져 있음 — 설정
  API(`/api/terminal/settings`)는 전역 401 인터셉터 혜택을 받지만, WebSocket
  업그레이드(`GET /api/terminal`) 자체가 게이트에 막히면 조용히 실패함(에러 UI
  없음) — `question.md` 참고.

## M2(named 영속 세션) — 여전히 미착수, 아래는 착수 전 근거 마련(구현 아님)

이번 라운드에 사용자가 명시적으로 요청: **tmux/screen에 의존하지 말 것**("버그
많음"). 이건 이미 위 "구현 방향" 절의 방향과 일치함 — webmanager가 PTY 프로세스
자체의 생명주기를 직접 관리(연결이 끊겨도 프로세스는 살려두고, 같은 이름으로
재접속하면 그 PTY에 재부착)하는 방식이지 tmux/screen을 셸 안에 끼워넣는 방식이
아니었음. 즉 M2는 "터미널 멀티플렉서 도입"이 아니라 **"WebSocket 연결 끊김과
PTY 프로세스 생명주기를 분리하는" 서버 사이드 설계** 문제 — 대략적인 그림
(구현 시 재검토 필요):

- 서버가 named 세션 레지스트리(이름 → `{cmd *exec.Cmd, ptyFile *os.File,
  scrollback 링 버퍼}`)를 인메모리로 유지. 세션 생성 시 이름 지정(중복 처리
  방식은 착수 시 결정), 이후 그 이름으로 다시 접속하면 새 PTY를 만들지 않고
  기존 PTY의 마스터 fd에 그대로 재연결.
  - PTY 출력은 WebSocket 연결이 없는 동안에도 계속 나올 수 있으므로, 연결이
    끊긴 동안의 출력을 버리지 않으려면 최근 N바이트/N줄 정도의 **scrollback
    링 버퍼**가 필요 — 재접속 시 그 버퍼를 먼저 흘려보내고 실시간 스트림으로
    전환.
  - 여러 WebSocket 연결이 같은 이름에 "거의 동시에" 붙는 경우(탭 두 개로 같은
    세션을 열었을 때)를 어떻게 할지는 M1의 "1:1 세션" 전제를 깨는 부분이라
    별도 설계 필요(허용할지, 마지막 연결만 유효하게 할지 등).
- 컨테이너 재시작하면 전부 사라짐(M1과 동일한 이미 알려진/의도된 제약,
  tmux/screen을 안 쓰기로 했으니 그걸로 재부팅을 버티게 할 생각도 없음).
- 이 설계가 tmux/screen보다 나은 점: 외부 바이너리에 대한 의존/버전 호환성/
  자체 버그 표면이 없음 — webmanager가 이미 하고 있는 "PTY 프로세스 하나를
  직접 관리"의 자연스러운 확장.
- **아직 결정 안 됨**(M2 착수 시): 세션 목록 UI(이름/생성 시각/마지막 접속),
  이름 중복 처리, 유휴 세션 자동 정리(타임아웃) 여부, scrollback 버퍼 크기.

`caddy-plan.md`에서 확정된 우선순위: dind 다음, caddy dev-proxy보다 먼저(전체 순서는
`webmanager/CLAUDE.md` 참고). dind는 이번 라운드에 리서치만 진행, 터미널은 사용자가
"충분히 구현 가능"이라 판단해 M1 구현 착수.

## 알려진 것

- xterm.js(프론트) + PTY(백엔드)로 여는 표준 패턴(ttyd/gotty/wetty와 동일 계열).
- code-server가 이미 통합 터미널을 제공하지만, webmanager 단독으로도 열리면
  code-server 없이도 최소한의 접근 수단이 됨(예: code-server 자체가 죽었을 때 복구용
  — 이게 이 기능의 핵심 존재 이유). **추가로 확인된 두 번째 존재 이유**: code-server
  세션과 무관하게 dev 서버 몇 개를 잠깐 띄워두고 싶을 때도 씀 — 그래서 M2에서
  "탭을 닫아도 살아있는 이름 붙은 세션"이 의미가 있음(아래 마일스톤 참고).

## 마일스톤 (확정)

- **M1 (지금 구현)**: 임시 세션만. 브라우저 쪽 연결(WebSocket)이 끊기면 그 PTY도
  즉시 종료 — 세션 목록/재접속 UI 없음, 열려있는 동안만 존재하는 단일 세션.
- **M2 (나중)**: 이름 붙은(named) 영속 세션 — 브라우저 탭을 닫아도 PTY 프로세스는
  살아있고, 나중에 같은 이름으로 다시 접속하면 그 세션에 재연결(스크린 상태까지
  포함할지는 M2 착수 시 재검토). "임시 세션"과 "영속 named 세션" 두 종류가 공존.
  **컨테이너 자체가 재시작되면 두 종류 다 사라짐** — PTY는 프로세스라 재부팅을
  버틸 수 없고, 이 기능 범위에서 그걸 버티게 하려는 시도(tmux/screen 같은 세션
  매니저를 webmanager가 대신 관리)도 하지 않음. 필요하면 사용자가 세션 안에서 직접
  `tmux`/`screen`을 쓰면 됨 — webmanager는 그 위에 UI만 얹지 않음(YAGNI, 필요해지면
  그때 재검토).
- M2 착수 시점에 결정할 것: 세션 목록 UI(이름/생성 시각/마지막 접속), 이름 중복
  처리, 유휴 named 세션의 자동 정리(타임아웃) 여부.

## 구현 방향 (확정)

- 새 의존성: 백엔드 `github.com/creack/pty`(PTY 할당, CGO 불필요 — Linux는 순수
  syscall 기반이라 이 레포의 `CGO_ENABLED=0` 빌드와 호환) + WebSocket 라이브러리
  (`github.com/coder/websocket` 또는 `nhooyr.io/websocket` 계열 표준적인 선택 —
  이 레포에 WebSocket 선례가 아직 없으므로 구현 시점에 하나 고름). 프론트
  `@xterm/xterm` + `@xterm/addon-fit`(터미널 렌더링 — 이 저장소가 다른 곳(차트)에서는
  "새 UI 라이브러리 안 들임" 원칙을 지켰지만, 터미널 에뮬레이션은 char-cell 렌더링부터
  ANSI 이스케이프 처리까지 직접 구현하는 게 비합리적이라 예외로 채택. 이미 ttyd/gotty
  등 동종 프로젝트의 사실상 표준 선택이기도 함).
- 쉘: `config/shell.*`가 정한 현재 쉘(기본 `/bin/fish`, override 가능)을 그대로
  spawn — 별도로 bash를 강제하지 않음, 사용자가 code-server 통합 터미널/SSH에서
  이미 쓰는 것과 동일한 환경.
- `WS /api/terminal` — 연결 시 PTY 생성, 이후 stdin/stdout을 그대로 WebSocket
  프레임으로 중계. 리사이즈는 별도 제어 메시지(JSON) 또는 WebSocket의 별도 채널로
  받아 `pty.Setsize`에 반영.
- webmanager는 code-server와 독립적인 supervisord program이라(이미 그렇게 설계됨)
  code-server가 죽어도 webmanager/터미널은 영향받지 않음 — 기존 전제 확인 완료,
  추가 조치 불필요.

## 인증 — 구현 완료 (2026-08-02): `authgate.RequirePassword` 게이트로 소급 적용됨

파일 매니저(`filemanager-plan-done.md`)도 같은 급의 비밀번호 게이트가 필요해지면서,
아래 설계 그대로 `internal/authgate` 패키지로 일반화 구현됨 — 터미널 전용이
아니라 **터미널 + 파일 매니저가 공유하는 단일 게이트**(`WEBMANAGER_AUTH_PASSWORD_HASH`
env var 하나)로 확정. `GET /api/terminal` 라우트가 `authgate.RequirePassword`로
래핑됨. **env var가 설정 안 돼 있으면 게이트는 기본적으로 열려있음**(fail-open) —
즉 M1이 원래 갖고 있던 "별도 인증 없음" 동작은 운영자가 비밀번호를 설정하기
전까진 그대로 유지됨, 아무것도 깨지지 않음. 아래 설계 그대로 구현됐고, 남은 건
`webmanager/.claude/attention-needed.md`의 관련 항목(정확한 env var 이름은
`WEBMANAGER_AUTH_PASSWORD_HASH`로 확정, 해시 계산 CLI 헬퍼는 아직 없음 — 지금은
`internal/authgate.HashPassword`를 호출하는 작은 스크립트/테스트 코드로 직접
생성해야 함) 참고.

**M1 초기 구현 시점 결정 기록** (아래는 구현 착수 전 사용자가 미리 설계해둔
내용, 실제 구현이 그대로 따름):

- **해시 알고리즘: argon2id.** `golang.org/x/crypto/argon2`가 이미 `go.mod`에
  있는 의존성(`golang.org/x/crypto`)이라 새 의존성 불필요. bcrypt보다 최신 권장
  선택이라 argon2id로 확정(GPU/ASIC 공격에 더 강함, 메모리 하드).
- **비밀번호(의 해시)는 오직 ENV로만 받는다.** JSON이나 다른 설정 파일에 저장하면
  "프로세스 kill → 파일 수정 → 재기동"으로 컨테이너 안에서 우회/변경이 가능해지는
  문제가 생김 — 반드시 프로세스 시작 시점의 환경변수로만 주입되게 해서, 이 값을
  바꾸려면 `docker-compose.yml`/`.env`(호스트 쪽, 컨테이너 안에서 못 건드림) 접근이
  필요하게 만듦. 저장하는 값은 평문이 아니라 **argon2id로 이미 인코딩된 해시
  문자열**(`$argon2id$v=19$...` 형식) — 평문 비밀번호 자체를 ENV에 두지 않음.
- **`/etc/environment` 교차 검증**: 시작 시점에 해당 ENV 값이 `/etc/environment`
  파일에도 정의돼 있는지 확인하고, 있으면 거부(기동 실패 또는 그 값 무시 + 경고
  로그)하는 방어 로직을 넣을 것 — 컨테이너 안에서 쉘 접근 권한이 있는 누군가가
  `/etc/environment`를 고쳐써서 "진짜" 환경변수처럼 보이게 만드는 걸 막기 위함.
  **현재 확인한 바로는 `script/entrypoint.sh`가 `/etc/environment`를 전혀 소싱하지
  않으므로 지금 당장은 이 공격 경로 자체가 없음** — 그래도 미래에 다른 초기화
  스크립트가 이 파일을 source하게 바뀌는 경우를 대비한 방어적 불변 조건으로 넣는
  것. (PAM의 `pam_env`는 로그인 쉘 세션에 `/etc/environment`를 반영하지만, supervisord가
  띄우는 webmanager 프로세스는 로그인 쉘 경로를 안 타므로 현재는 영향 없음.)
- ~~남은 세부사항~~ — 위 "구현 완료" 절 참고: env var 이름은
  `WEBMANAGER_AUTH_PASSWORD_HASH`로 확정, 터미널 전용이 아니라 파일 매니저와
  공유하는 게이트로 확정. **해시 계산 CLI 헬퍼는 아직 없음** — 여전히 열린
  일감(`attention-needed.md` 참고).

## API 초안 (구현 전 상상, 재검토 필요)

`WS /api/terminal` — `creack/pty`로 새 쉘 세션 생성, xterm.js와 WebSocket으로 연결.
정확한 메시지 프레이밍(리사이즈 제어 채널 포함)은 구현 시 확정.

## 구현 시 확인할 것 (M1 착수 시 남은 디테일)

- WebSocket 라이브러리 최종 선택 (`coder/websocket` vs 다른 후보) — 구현 시점에
  가벼움/유지보수 활발함 기준으로 하나 고르면 됨, 지금 막히는 결정 아님.
- 여러 클라이언트가 같은 세션에 동시 접속할 때의 동작(M1은 세션이 애초에
  1:1이라 해당 없음 — M2 named 세션에서만 고려 필요).
