# code-server 위젯 안의 webmanager - 잠금 해제 버그 2건 (2026-09-29 제보)

오너가 직접 발견, 같은 날 원인 실측(서브에이전트). 아직 안 고침.

## B1 - 위젯에서 지문(WebAuthn) 기기 등록 실패

- **재현**: code-server에서 webmanager를 위젯으로 열고, 커맨드 팔레트에
  `>fingerprint unlock devices` → 모달 → 등록.
- **증상**: `등록하지 못했습니다(Invalid 'sameOriginWithAncestors' value).`
- **추정 위치**: `webmanager/vscode-extension/media/embed.js`,
  `webmanager/frontend/src/embed.ts`, `webmanager/frontend/src/utils/webauthn.ts`,
  `components/common/WebAuthn.tsx`. 교차 출처 iframe(code-server webview) 안에서
  `navigator.credentials.create()`를 부르는 경로 또는 부모 프레임으로 위임하는
  경로 중 하나의 문제로 보임.
- **원인 (실측 확인, 신뢰도 높음)**: webmanager 코드 버그가 아니라 브라우저에 깔린
  **Bitwarden 확장**(FIDO2 후킹)이 원인이다. 이 문구는 Chrome이 아니라 Bitwarden의
  `background.js`가 던지는 `DOMException("Invalid 'sameOriginWithAncestors' value")`이고,
  MAIN world에 주입되는 `content/fido2-page-script.js`(`all_frames: true`)가 모든 프레임의
  `navigator.credentials.create()`를 가로챈다. 그때 content script
  (`fido2-content-script.js:1098`)가 `sameOriginWithAncestors: globalContext.self ===
  globalContext.top`으로 계산하므로, **최상위 창이 아닌 프레임이면 same-origin이어도 무조건
  false**로 거부된다. code-server 위젯은 webview 2겹 iframe 안이라 항상 걸린다
  (`webauthn.ts:210` `navigator.credentials.create` -> `WebAuthn.tsx:150-152`가
  `등록하지 못했습니다 (…)`로 그대로 표시).
  - 실측(Helium 브라우저, code-server + 임시 webmanager 인스턴스): 위젯 UI에서 등록을 누르면
    같은 문구 재현. options 내용과 무관하게 **same-origin 직계 자식 iframe(`allow`
    속성 포함, 사용자 클릭 직후)에서도 즉시 같은 에러**, 최상위 창에서는 즉시 거부 없이
    프롬프트가 뜸(pending). `document.featurePolicy.allowsFeature('publickey-credentials-
    create')`는 true라서 permissions policy(`vscode-extension/src/html.js:79`의 `allow`)나
    postMessage 릴레이 문제가 아님. `get()`은 iframe에서도 즉시 거부되지 않음(등록만 영향).
  - 확장 소스는 `~/.config/net.imput.helium/Default/Extensions/nngceckbapebfimnlniiiahkandclblb/
    2026.9.2_0/` 에서 확인. Bitwarden을 끄고 재시험한 것은 아님(미검증) — 그래도 문구 출처와
    `self === top` 로직이 정확히 일치.

- **수정 방향**: (1) 임베드 모드에서는 `enrollWebAuthn`(`webauthn.ts:206-226`)의 `create()`를
  최상위 창에서 실행한다 — 체인 전체가 same-origin이라(검증됨) `window.top.navigator.
  credentials.create(...)`를 직접 부르거나, `embed.ts`의 `postToHost`/`embed.js` 릴레이 대신
  code-patch 스크립트(`config/code/code-patch/`, 최상위 창에 주입됨)가 메시지를 받아 실행 후
  직렬화된 결과를 돌려주는 방식. 최상위 호출은 Bitwarden에서 즉시 거부되지 않는 것까지만
  확인했고(pending), 실제 인증기 완료와 Chrome의 포커스 요구는 미검증 — 구현 시 실기기 확인
  필요. (2) 어떤 경우든 폴백: 에러 메시지가 `sameOriginWithAncestors`를 포함하면
  `WebAuthn.tsx:150`에서 "브라우저 확장(Bitwarden 등)이 iframe 안 등록을 막습니다 —
  새 탭에서 등록하세요" 안내 + `postToHost({type:'open-external', url:'/manager/'})`로 새 탭
  열기 버튼을 노출. 잠금 해제(`get`)는 iframe에서 그대로 동작하므로 등록 경로만 손보면 된다.

## B2 - 위젯 터미널에서 비밀번호 해제 취소 후 다이얼로그가 두 개 뜸

- **재현**: code-server 위젯의 터미널 영역에서 비밀번호 풀기 다이얼로그를 취소 →
  배경에 "비밀번호로 풀어야 쓸 수 있다" 안내가 뜸 → 거기서 풀기를 다시 누름.
- **증상**: 비밀번호 다이얼로그가 두 개 뜬다. 하나는 배경에 깔려 눌리지 않고,
  하나는 앞에 뜬다.
- **추정 위치**: `components/common/RequiresUnlock.tsx`, `UnlockModal.tsx`,
  `webauthnGate.ts` - 취소 시 첫 모달이 언마운트되지 않거나 게이트 상태가 두 번
  구독되는 쪽.
- **원인 (부분 실측, 신뢰도 중상)**: 다이얼로그 두 개는 서로 다른 두 컴포넌트다 — 앞의 것은
  전역 `UnlockModalHost` 모달(`UnlockModal.tsx:108-146`), 배경에 눌리지 않는 것은
  `RequiresUnlock`의 인라인 카드(`RequiresUnlock.tsx:56-80`)로, **둘 다 제목이 "잠금 해제 필요"**
  라서 똑같은 다이얼로그처럼 보인다. 모달은 카드가 화면에 있는지 모르고 열리고
  (`prompt()` `UnlockModal.tsx:30-35`, `requestUnlock()` `client.ts:28`), 반대로 카드는
  `useAuthStatus`가 갱신될 때 언제든 Terminal을 대체한다(`RequiresUnlock.tsx:52-56`).
  모달 뒤에 카드가 깔리는 경로: 터미널의 `/terminal/sessions` 폴링(`api.poll`,
  `Terminal.tsx:937`)이 401을 받으면 `client.ts:181-183`이 모든 상태 소비자를 갱신 ->
  `RequiresUnlock`이 카드로 교체. 그 사이/직후 Terminal의 잠금 오버레이 "잠금 해제" 버튼
  (`Terminal.tsx:3547-3556` -> `unlockAndReconnect` `:1238-1246` -> `requestUnlock`)이나
  비폴링 gated GET(cwd `:3159` 등)의 401 프롬프트(`client.ts:184-195`)가 모달을 연다.
  취소는 `promptDeclinedAt` 60초 쿨다운으로 읽기 프롬프트만 억제(`client.ts:46-60`)하고
  버튼(쓰기/`requestUnlock`)은 억제되지 않아 다시 누르면 카드 위에 또 모달이 뜬다.
  - 실측: 임베드 터미널이 잠기면 오버레이 -> 1.2~1.5초 뒤(폴링 주기) 카드로 교체되는 것을
    타임라인으로 확인(Terminal 언마운트, 모달은 0개). 카드가 떠 있는 상태에서 모달을 여는
    경로 하나(비임베드 사이드바 잠금 표시 `SidebarFooter.tsx:59` -> `requestUnlock`)로
    "앞 모달 + 뒤 카드" 2중 다이얼로그를 그대로 재현. 임베드의 정확한 트리거(오버레이 버튼
    vs 401 GET) 타이밍은 자동화로 못 맞춰 직접 재현하지는 못함 — 메커니즘은 동일.
  - 첫 모달이 언마운트되지 않거나 게이트가 이중 구독되는 문제는 아님: `UnlockModalHost`는
    `App.tsx:499`에 한 번만 마운트되고 `handleCancel`(`UnlockModal.tsx:78-83`)은 정상적으로 닫힘.
- **수정 방향**: 인라인 카드가 떠 있는 동안에는 전역 모달을 열지 않는다. `client.ts`에
  "인라인 게이트 표시 중" 카운터(`RequiresUnlock`이 카드를 렌더링하는 동안 증가/감소하는
  `registerInlineGate()`)를 두고, `prompt()`가 카운터 > 0이면 모달 대신 카드 입력창에 포커스만
  주며 대기자(waiter)는 그대로 등록해 둔다 — 대기자 해소는 `UnlockModal.tsx:46-62`의
  `onAuthStatusChange` 효과가 `open`일 때만 동작하므로 `open` 조건을 풀거나 카드 unlock 성공 시
  `finishUnlocked` 경로로 흘려야 한다. 더 단순한 대안: 카운터 > 0이면 `request()`의 401 프롬프트와
  `requestUnlock()`을 즉시 reject(카드가 이미 묻고 있으므로). 추가로 열린 모달이 있을 때 카드가
  나타나면(=반대 순서) 카드 표시를 잠깐 숨기는 것은 불필요 — 위 카운터 하나로 두 순서 모두 해결.

## B3 - 위젯 터미널: 잠금 해제 후 화면 크기가 안 맞음 (오너 관측, 2026-09-29)

- **증상**: code-server 위젯에서 비밀번호로 잠금을 풀고 터미널에 들어가면 그 안의
  Claude Code 앱 화면이 깨져 있다. 위젯(창) 크기를 조절하면 정상으로 돌아온다.
- **오너 추정**: xterm과 터미널 앱이 준비되기 전에 크기 계산/전송이 먼저 일어나거나,
  아예 크기 설정이 안 가는 것. 아직 원인 미확인.
- **원인 (2026-09-29 CDP 실측으로 확정, 수정함)**: 크기 "전송"이 아니라 폰트 측정 문제.
  (1) 연결 effect가 터미널 설정(폰트 패밀리) 도착을 기다리지 않아, 잠금 해제로 Terminal이
  재마운트되면 기본 폰트 크기로 PTY에 붙었다가 0.4초 뒤 설정이 오며 다시 리사이즈 - 재접속
  리플레이 중 SIGWINCH 두 번. (2) xterm은 폰트 옵션이 바뀔 때만 칸 크기를 재므로, 설정이
  온 시점에 Jetendard(.ttf)가 아직 로딩 중이면 대체 글꼴 metrics(8px)로 굳어 첫 로드부터
  열 수가 틀림 → 다음 재마운트(캐시된 폰트, 9px)에서 크기가 바뀜. 실측: 잠금 해제 직후 PTY
  47x114 → 35x102, Claude Code 화면 어긋남 재현.
- **수정**: 설정 + 폰트 로드(최대 2초)까지 첫 연결 대기(`fontReady`), 폰트 로드 뒤 옵션을
  바꿨다 되돌려 xterm 재측정(`remeasureFont`), 이후 `loadingdone`에도 재측정 + resize.
  같은 시나리오(캐시 비움) 재실측: 첫 로드부터 35x102, 잠금 해제 후 PTY 변화 없음, 화면 정상.
- **볼 곳(당시)**: 잠금 해제 → Terminal 재마운트 경로(`RequiresUnlock` 카드가 Terminal을
  대체했다가 되돌리는 흐름, B2 참고)에서 fit/resize가 언제 호출되는지, 숨겨진(0 크기)
  컨테이너에서 fit한 값이 PTY로 가는지, 재접속 시 PTY에 resize를 다시 보내는지.
