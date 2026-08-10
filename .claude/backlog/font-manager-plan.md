# 폰트 매니저 (아이디어 정리 — 구현 전, 사용자 노트 원문 기반)

2026-08-10, 사용자가 다른 여러 요청과 함께 남긴 노트를 정리한 문서. 스코프가 크고
(파일 업로드 UI, code-server 패치, webmanager 터미널/UI 설정 연동까지 걸쳐 있음)
다른 급한 항목들을 먼저 처리하느라 이번 라운드엔 착수하지 않음 — 구현 전 설계
스케치 + 착수 시 확인해야 할 지점 정리 용도.

## 동기

폰트 관리를 지금 손으로 해야 해서 번거로움 (`~/.server/patch/fonts/` 아래
ttf 파일을 직접 넣고 CSS `@font-face`도 손으로 관리 중). ttf 업로드 가능한
매니저를 webmanager에 만들고, 거기서 관리하는 폰트를 웹매니저 자신의 터미널/UI
폰트로도 선택해서 쓸 수 있게 하고 싶음. code-server 쪽에도 코드패치로 주입해서
동일 폰트를 code-server 내장 터미널(xterm.js — webmanager 웹터미널과 같은
엔진)에서도 쓸 수 있을 것으로 추정됨(사용자 본인 확인, 미검증).

## 사용자가 이미 겪고 있는 실제 사례 (시딩 시 참고)

`ls ~/.server/patch/fonts`:
```
monoflex
victor
KawaiiMonoRegularPatched-v14-79ed47537944a4f5.ttf
KawaiiMonoRegularPatched-v15-79ed47537944a4f5.ttf
KawaiiMonoRegular-v2.ttf
KawaiiMonoRegularPatched-v28-c59212b1cbd914ce.ttf
```
- Kawaii Mono는 nerd 글립 포함해서 자주 갱신되는데, 캐싱이 잘 안 풀려서 파일명에
  짧은 해시를 붙여 충돌을 피하는 중 (`KawaiiMonoRegularPatched-v28-<hash>.ttf`).
- 실제 쓰고 있는 `@font-face` 예시:
  ```css
  @font-face {
    font-family: 'Victor Mono';
    src: url('./fonts/victor/VictorMono-Regular.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
  }
  @font-face {
    font-family: 'KawaiiMono';
    src: url('./fonts/KawaiiMonoRegularPatched-v28-c59212b1cbd914ce.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
  }
  ```
- 크롬이 `font-family`가 실제로 적용된 요소가 있을 때만 온디맨드로 ttf를
  불러온다는 점(사용자 본인 확인) 덕분에, 폰트 개수가 많아져도 실사용 성능
  부담은 크지 않을 것으로 봄 — "안 쓰이는 폰트가 여러 개 있어도 괜찮다"는
  전제로 설계해도 될 듯.

## 설계 스케치

### 저장 위치

`/code/.local/managed-fonts/` 아래, 웹으로 자동 관리되는 폰트는 파일별
서브폴더 없이 한 폴더에 모아둬도 무방(사용자 본인 언급 — 사람이 손으로 관리할
때만 `victor/`, `monoflex/` 같은 폴더 구분이 편한 것) — 다만 실제 폰트 파일
(`*.ttf`/`*.otf`/...)과 그걸 가리키는 `fonts.css`(또는 `fonts.json`/`.yaml` 메타)를
같은 디렉토리에 두는 구조로 하되, `code-docker` 자체가 시딩하는 기본 폰트
(아래 "기본 시딩 폰트" 참고)는 `/code/.local/managed-fonts/code-docker/` 같은
서브폴더로 분리해서 사용자가 직접 추가한 폰트와 구분 짓는 것도 고려 가능 —
착수 시 결정.

### 관리 대상 메타데이터 (폰트 파일 하나당)

- `family`: CSS `font-family` 이름
- `weight`: 100~900 정수, 단 UI 표시는 숫자 뒤에 `normal`/`bold`/`extrabold` 같은
  이름을 같이 보여주면 편함(사용자 요청)
- `style`: `normal` / `italic` / `oblique` 등
- `format`: `truetype` / `opentype` / `woff`/`woff2` 등 (`@font-face`의 `format()`에
  대응)
- 실제 파일 경로

### font-family 단위 그룹핑 (UI)

같은 family 아래 여러 weight/style이 들어가는 경우가 많아 목록이 길어짐 —
family별로 접고 펼 수 있는 아코디언 형태로 보여주면 될 듯(사용자 요청).

### webmanager와의 연동

- 업로드된 폰트들로부터 생성된 `fonts.css`를 webmanager 프론트엔드에서
  `<link>` 또는 `@import`로 로드.
- `internal/terminalsettings`(터미널 폰트/테마 설정을 이미 백엔드 영속화하고
  있는 기존 패키지 — `webmanager/CLAUDE.md` 참고)에 "관리 폰트 중 선택" 옵션을
  추가 — 지금 터미널 설정 UI에 이미 있는 폰트 선택 필드를 관리 폰트 목록에서
  고르는 드롭다운으로 확장하는 형태가 자연스러워 보임. UI 폰트(터미널이 아닌
  전체 웹매니저 UI)에도 같은 방식으로 적용 가능해 보이나, 이건 별도
  `uiprefs`(이미 존재하는 패키지로 추정, `internal/uiprefs`) 쪽 확장이 필요할 수
  있음 — 착수 시 확인.

### code-server 연동 (code-patch)

`config/code/code-patch/`는 이미 범용 메커니즘(`<name>.default.<ext>` +
선택적 `.override.<ext>`가 `/code/.local/share/code-docker/code/patch/<name>.<ext>`로
시딩되고, code-server-autoinstall이 모든 `patch/*.js`를 `<script>`로 자동
주입 — 루트 `CLAUDE.md` 참고). 여기에 `fonts.css`를 code-server 쪽에도 주입하는
새 patch 항목을 추가하면, xterm.js 기반인 code-server 내장 터미널에서도 같은
폰트를 쓸 수 있을 것(미검증 — 착수 시 실제 code-server 내장 터미널이 커스텀
`@font-face`를 인식하는지 먼저 확인 필요).

### 기본 시딩 폰트

- Victor Mono, IBM Plex Mono Nerd(보통 "BlexMono Nerd"로 불림)를 기본으로
  시딩.
- `user-init.sh`에서 처리하는 게 자연스러워 보이나(폰트 다운로드는 홈 폴더
  세팅류), 루트 `CLAUDE.md`의 "Non-essential setup should degrade gracefully"
  피드백 메모리와 동일한 원칙 적용 — 다운로드 실패해도 컨테이너 부팅을 막으면
  안 됨, warn+skip.
- `env`로 opt-out 가능하게 — 사용자가 예시로 든 이름은 "default font download"
  계열. 실제 값은 착수 시 example-env 컨벤션에 맞춰 정하면 됨(예:
  `SEED_DEFAULT_FONTS=false`).

## 미해결 질문

1. 업로드 UI가 브라우저에서 직접 ttf 바이너리를 POST하는 형태로 충분한지,
   아니면 URL에서 받아오는 옵션도 필요한지 (Kawaii Mono처럼 자주 갱신되는
   폰트는 매번 손으로 재업로드하는 게 번거로울 수 있음 — "URL 등록하고 새로고침
   버튼으로 재다운로드" 같은 보조 기능이 있으면 편할 수도 있으나 스코프 확장이라
   후순위로 미뤄도 됨).
2. `fonts.css` 재생성 시점 — 업로드/삭제/메타 수정마다 즉시 재생성할지, 명시적
   "적용" 버튼을 둘지.
3. code-server 내장 터미널이 code-patch로 주입한 `@font-face`를 실제로 인식하는지
   사전 검증 필요 (사용자 본인도 "될 것 같긴 함"이라고만 언급, 확정 아님).
4. UI 폰트 적용 범위 — 웹매니저 전체 UI에 적용 시 CJK/이모지 폴백 체인이 깨지지
   않도록 `font-family` 목록 뒤에 시스템 기본 폰트를 계속 남겨두는 처리가 필요해
   보임 (사용자가 업로드하는 폰트가 라틴 전용일 가능성이 높음).

## 참고

- 사용자가 직접 준 캐시-버스팅 파일명 예시, `@font-face` 예시는 위 "사용자가
  이미 겪고 있는 실제 사례" 절 참고.
- `config/code/code-patch/` 메커니즘 — 루트 `CLAUDE.md`.
- `internal/terminalsettings` — 기존 터미널 설정 영속화 패턴, 폰트 선택 필드
  확장 시 재사용.
