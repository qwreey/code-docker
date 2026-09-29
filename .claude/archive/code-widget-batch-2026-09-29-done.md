# code-server 위젯(webmanager 확장) 노트 묶음 - 2026-09-29 오너 제보

진행 순서: 버그(1~3) 먼저, 편의(4~5) 다음. 하나씩 커밋. 재현/검증은 CDP(아래 "실측 방법").

## 1. [버그] 바텀 뷰 터미널을 위(에디터 영역)로 옮긴 뒤 같은 세션이 두 군데 붙음

- **재현(오너)**: 바텀 뷰(webmanager 패널)에 터미널이 있는 상태에서 그 탭을 위로 빼면
  에디터 영역으로 올라간다. 그 뒤 다시 열린 바텀 뷰에서 "위로 올려보낸 탭"을 누르면 위에
  하나, 아래 하나 - 같은 세션을 두 뷰가 공유하고, 한쪽에 입력하면 다른 쪽에도 보인다.
- **기대**: 한 세션은 한 뷰에만. 이미 위에 열려 있으면 그쪽으로 포커스를 옮기거나, 바텀
  뷰의 그 탭은 없어져야 한다.
- **볼 곳**: `webmanager/vscode-extension/extension.js`(패널/에디터 호스트, 세션→뷰 매핑,
  "move to editor" 처리), `src/sessions.js`, `media/embed.js`. 두 클라이언트가 같은 PTY에
  붙으면 크기도 서로 싸운다(`d191619`/F23과 같은 부류).

## 2. [버그] webmanager 위젯 아이콘이 테마를 안 따름

- 다크 테마에서 아이콘이 검정으로 나온다.
- **볼 곳**: `vscode-extension/package.json`의 viewsContainers/views/commands `icon`,
  `media/icon.svg` - `fill`이 하드코딩돼 있으면 `currentColor`로, 또는 light/dark 아이콘 쌍.

## 3. [버그/회귀?] 탭 포커스 복귀 시 터미널 크기 재조정이 안 됨

- 다른 탭(같은 브라우저/PWA 창의 다른 탭)에서 창 크기를 바꾼 뒤 이 탭으로 돌아오면,
  열려 있던 터미널 크기가 복구되지 않는다. code PWA 창을 활성화해도 마찬가지.
- 일반 `/manager/`에서도 재현됨 → 위젯 전용 문제가 아님. 원래 없던 기능인지 회귀인지
  git log로 확인(visibilitychange/focus 리핏 흔적 검색).
- **추정**: 숨겨진 탭에서는 ResizeObserver가 늦게/안 돌거나, 돌아왔을 때 크기가 같다고
  보고 PTY에 resize를 안 보냄. 다른 클라이언트(다른 탭)가 PTY 크기를 바꿔 놓았으므로
  돌아온 쪽이 "자기 크기"를 다시 보내야 한다(`sendResize`의 sentSizes 캐시가 막을 수
  있음 - 소켓별 마지막 전송값이 같으면 안 보냄). `visibilitychange`/`focus`에서 강제 재전송
  + 필요시 repaint nudge(서버 `nudgeRepaint`는 이제 100ms 간격, `beb3067`).

## 4. [편의] 바텀 뷰에서 새 탭(새 세션) 여는 버튼이 없음

- 지금은 "세션 바꾸기"만 있어서 팔레트 없이는 바텀 뷰에서 세션을 하나 더 열 수 없다.
- **볼 곳**: `vscode-extension/package.json`의 `view/title` 메뉴, `extension.js`의 명령
  (`webmanager.openTerminalInPanel` 등).

## 5. [편의] 위젯에서 새로 연 터미널 세션은 기본 pin

- webmanager 위젯으로 직접 연 세션은 일반 code 터미널처럼 나가도(패널을 닫아도) 안
  사라지는 게 낫다 → 새로 만들 때 pin 기본값 true.
- **볼 곳**: 세션 생성 경로(확장의 새 세션 → webmanager `terminal?session=...&created=`),
  백엔드 `termsession` pinned/idle GC(`SetPinned`, `reapIdle`), `webmanager.view.togglePin`.

## 실측 방법 (메모리 `reference_cdp-headless-widget-testing` 참고)

- 격리 프로필 headless Chrome + CDP: `/tmp/cdp-work/cdp.mjs`, `run.mjs`(Node 내장
  WebSocket), 프레임별 평가 `p.evalIn('/manager/terminal', expr)`, 커맨드 팔레트는 F1.
  남아 있는 스크립트 예: `setup.mjs`(위젯 터미널 열기), `full.mjs`.
- 테스트 스택: `.allow-test` 있음. `.env`가 dev/ 체크아웃을 바인드(router만 지금 원격
  v0.1.5로 빌드돼 있음). 비밀번호 잠금이 필요하면 `--hash-password`로 임시 설정 후 원복.
- Chrome 종료: `pgrep -f '[r]emote-debugging-port=9333' | xargs -r kill`
  (`pkill -f`는 자기 셸까지 죽임).

## 결과 (2026-09-29, 전부 CDP 실측)

1. `3d86f11` - Home에서 고른 세션은 확장에 묻고(`open-session`), 이미 다른 뷰에 있으면 그쪽으로
   포커스. 실측 중 원래 있던 버그 하나 더: 에디터 탭을 닫으면 `onDidDispose`의 `forgetTitle`이
   폐기된 패널의 `title`을 읽다 `Webview is disposed`로 던져 `detach`가 안 돌았고, 그 세션을
   다시 열면 죽은 패널을 reveal하며 조용히 실패했다(exthost 로그로 확인).
   `89e6a12` - 탭을 닫은 직후 새로고침하면 VS Code가 닫기 전 레이아웃으로 그 탭을 되살린다
   (상태 없이 빈 Home으로, 또는 슬롯이 이미 보여 주는 세션으로). serializer가 닫는다.
2. `453d2dd` - 탭 아이콘은 이미지로 그려져 `currentColor`가 검정. light/dark 쌍.
3. `2729564` - 회귀였다: `173d176`의 포커스 시 크기 되찾기를 `2ab4c9b`의 소켓별 중복 제거가
   막음. 포그라운드에선 강제 전송(같은 크기면 커널이 SIGWINCH 안 보냄), 임베드는 확장이
   `onDidChangeWindowState`를 `foreground`로 전달. headless는 창 포커스를 모델링 안 해서
   top 문서의 `hasFocus`를 덮어쓰고 blur/focus를 보내 흉내 냄.
4. `c39a5ef` - `webmanager.newTerminalInPanel`, 터미널 슬롯 제목 줄 `+`.
5. `08e84dd` - WS `pin=1`(생성 시에만), 사용자가 푼 세션은 `unpinned=1`로 재생성 시 유지.

code-review 후속: `15649c0`. 열린 질문: 기본 고정이라 탭·칸을 닫아도 세션이 남고 고정 세션은
닫기 버튼이 숨겨져 쌓일 수 있음 - 닫을 때 고정 해제/종료 여부는 오너 결정 대기.
