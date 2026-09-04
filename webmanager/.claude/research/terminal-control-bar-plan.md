> **상태 갱신 (2026-09-04): 이 문서의 대부분은 구현·배포·실측 검증까지 끝났다.**
> 남은 것은 맨 아래 "안 한 것"뿐이니, 이 문서를 "착수 전"으로 읽지 말 것.
>
> - 하단 컨트롤 바 숨김 토글 — 구현됨. localStorage `webmanager.terminal.controlBarEnabled`,
>   기본값은 `(pointer: fine)`이면 숨김. 토글은 **즉시 적용**(탭 재마운트 불필요).
> - 줌 그룹을 탭 줄 오른쪽으로 이동 — 구현됨. **저위험 안**(flex 분배)으로 갔다.
>   `position: sticky`도 탭바 가로 스크롤 전환도 하지 **않았다**.
>   `.terminal-tabbar` 안에 `.terminal-tab-list`(줄바꿈 유지)와
>   `.terminal-zoom-group`(`flex: none; align-self: center`)이 형제로 들어간다.
>   실측: 오른쪽 끝에서 9px, 세로 오프셋 0, 탭 8개로 2줄 접힘 상태에서도 유지, 겹침 없음.
> - xterm 하단 잘림 — 이 문서가 "원인 미확정"으로 남긴 항목인데 **원인이 밝혀져
>   고쳐졌다**. 서브픽셀 반올림도 낡은 fit도 아니고, 전역 `box-sizing: border-box`
>   때문에 FitAddon이 `.terminal-container`의 패딩을 가용 높이로 오인한 것이었다.
>   패딩을 `.xterm`으로 옮겨 해결(커밋 `253afe9`). 실측·사용자 확인 완료.
>
> **안 한 것 (이 문서에서 아직 유효한 부분)**: 탭바를 가로 스크롤 스트립으로 바꿔
> 진짜 `position: sticky` 줌 그룹을 두는 안. 실제 동작 변경이라 사용자 결정이 필요하다.

# 터미널 모바일 컨트롤 바 — 높이 계산 / 데스크탑 숨김 토글 / 줌 이동

작성 2026-09-03. **착수 전, 조사만 함.** `Terminal.tsx`/`TerminalTabs.tsx`/
`TerminalSettingsPanel.tsx`/`Terminal.css` 전부 조사 시작 한 시간 이내에 수정된
상태에서(포커스 리사이즈, "code로 열기" 링크, 자동 재연결 백오프, rename 포커스,
`draggable={!isEditing}`) 그 최신 버전을 다시 읽고 작성함.

## 증상 (사용자 보고 그대로)

1. 하단 모바일 컨트롤 바(`TerminalControls.tsx` — 모디파이어/화살표/줌)가 차지하는
   영역이 xterm 크기 계산에 제대로 반영되지 않아, 터미널 텍스트 맨 아래 줄(들)이
   잘려 보인다.
2. 컨트롤 바는 데스크탑에서는 쓸모가 없다 — 기기별로 켜고 끌 수 있는 옵션이
   필요하다.
3. 바를 숨겼을 때 줌(−/+) 버튼은 탭 행(`TerminalTabs.tsx`) 맨 오른쪽으로
   position-sticky로 옮겨가야 한다.

## 원인 분석

### 항목 1 — 컨트롤 바 높이가 xterm 크기 계산에 반영되는가

**확정된 사실 (코드로 직접 확인함):**

- `.terminal-surface`는 `display:flex; flex-direction:column`이고
  (`Terminal.css:220-227`), 그 안에 `.terminal-container`(`containerRef`,
  Terminal.tsx:1532)와 `.terminal-controls`(`<TerminalControls>`,
  Terminal.tsx:1575)가 **형제(sibling)로 같은 flex 컬럼 안에 순서대로**
  들어있다 — 별도 오버레이나 절대배치가 아니다.

  ```css
  /* Terminal.css:220-227 */
  .terminal-surface {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--term-bg, #000);
  }
  ```

  ```css
  /* Terminal.css:274-280 */
  .terminal-container {
    flex: 1;
    min-height: 0;
    min-width: 0;
    padding: 0.4rem 0.5rem 0;
    overflow: hidden;
  }
  ```

  ```css
  /* Terminal.css:304-311 */
  .terminal-controls {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.4rem;
    overflow-x: auto;
    padding: 0.4rem 0.5rem;
    flex: none;
  }
  ```

  즉 `.terminal-controls`는 `flex: none`(자기 콘텐츠 크기만큼만 차지)이고
  `.terminal-container`는 `flex: 1; min-height: 0`(나머지 전부를 가져감) —
  **컨트롤 바 높이를 하드코딩으로 빼는 코드는 어디에도 없다.** 브라우저가 매
  레이아웃 패스마다 `.terminal-controls`의 실제 렌더링 높이를 먼저 정하고
  `.terminal-container`가 남는 공간을 갖는, 순수 flex 계산이다.

- FitAddon(`node_modules/@xterm/addon-fit/lib/addon-fit.js`)의
  `proposeDimensions()`는 `this._terminal.element.parentElement`의
  `getComputedStyle(...).height`를 읽는다. `term.open(container)`가
  `containerRef`(= `.terminal-container`)에 대고 호출되므로(Terminal.tsx:750
  부근) 이 `parentElement`는 정확히 `.terminal-container`다. `getComputedStyle().height`는
  (box-sizing과 무관하게) **content-box 높이의 사용값(used value)**이라
  `.terminal-container` 자신의 padding과, flex로 이미 제외된 `.terminal-controls`의
  높이가 둘 다 자동으로 빠져 있다. 즉 fit() 시점에 읽는 값 자체가 "지금 실제로
  화면에 그려진" 크기이지, 코드가 미리 가정해둔 상수가 아니다.

- `ResizeObserver`는 `container`(=`.terminal-container`) 자신을 관찰한다
  (Terminal.tsx:1097-1105). 관찰 대상 엘리먼트의 렌더링 박스가 바뀌면 원인이
  무엇이든(형제인 컨트롤 바가 늘어나거나 줄어드는 것 포함) 콜백이 불린다 —
  `--kb-inset` 변화(가상 키보드)든, 탭 바가 줄바꿈되어 `.terminal-surface`의
  남는 높이가 줄어들든, 전부 이 경로로 잡힌다.

  ```js
  // Terminal.tsx:1097-1105
  const resizeObserver = new ResizeObserver(() => {
    if (container.clientWidth === 0 || container.clientHeight === 0) return
    fitAddon.fit()
    sendResize()
  })
  resizeObserver.observe(container)
  ```

- `.terminal-controls`는 `flex-wrap: nowrap; overflow-x: auto`다(위 CSS 인용).
  즉 **줄바꿈되지 않는다** — 버튼이 넘치면 가로 스크롤될 뿐, 2줄로 늘어나
  높이가 커지는 일이 없다. (반대로 `.terminal-tabbar`는 `flex-wrap: wrap`이라
  실제로 줄바꿈된다 — 아래 "항목 3" 참고. 조사 지시에서 언급한 "좁은 화면에서
  바가 2줄로 줄바꿈되어 높이 가정이 stale해지는" 시나리오는 **컨트롤 바가
  아니라 탭 바 쪽 얘기다**, 컨트롤 바 자체 높이는 사실상 고정값이다.)

- Home ↔ 세션 탭 전환 시 `.terminal-container`의 `hidden` 속성과
  `<TerminalControls>`의 조건부 렌더는 **같은 `activeSession` state 하나**로
  같은 커밋에서 함께 바뀐다(Terminal.tsx:1532, 1575). WS-connect 이펙트가
  부르는 `fitIfVisible()`(Terminal.tsx:1159)은 React 커밋 이후 페인트가 끝난
  뒤 실행되는 `useEffect`이므로, 이 시점엔 DOM에 컨트롤 바가 이미 붙어
  레이아웃이 확정된 뒤다 — 이 부분에 대한 주석도 명시적으로 이 레이스를
  의식하고 쓰여 있다:

  ```js
  // Terminal.tsx:1152-1158 부근
  // The container was hidden until the render that scheduled this effect
  // committed, so fit here (now that it has a real box) rather than
  // trusting whatever size the terminal happens to be carrying. ...
  ```

**결론(확정)**: "컨트롤 바가 차지하는 영역이 xterm 크기 계산에 하드코딩된
상수로 빠지거나, 낡은(stale) 값으로 가정된다"는 형태의 버그는 **코드 상으로는
존재하지 않는다.** flex 레이아웃과 `getComputedStyle`/`ResizeObserver` 조합은
매번 실제 렌더링 결과를 읽고 실시간으로 반응하도록 이미 짜여 있다.

**가설 (미검증, 실기기 확인 필요) — 그럼 실제로 보이는 "잘림"은 뭔가:**

- **H1 (가장 유력): 실제 글리프 잘림이 아니라 여백 없음으로 인한 착시.**
  `.terminal-surface`/`.terminal-container` 자체가 "터미널과 컨트롤 바를 이음매
  없는 하나의 표면으로 보이게" 만드는 게 의도된 디자인이다:

  ```css
  /* Terminal.css:209-213 주석 */
  /* Terminal + control bar merged into one seamless surface (Termux-style —
     no border/gap between the two so the controls read as part of the
     terminal itself, not a separate toolbar floating above it) ... */
  ```

  FitAddon은 `rows = floor(availableHeight / cellHeight)`로 행 수를 내림
  계산하므로, 셀 높이로 나누어떨어지지 않는 나머지(1행 미만)는 항상 여백으로
  남는다. 이 여백은 `.xterm-viewport`의 배경색을 `--term-bg`에 맞춰뒀기 때문에
  (Terminal.css:286-294) 시각적으로 완전히 안 보인다 — 그리고 그 바로 아래
  경계선/그림자 하나 없이 컨트롤 바가 곧바로 이어 붙는다. 즉 "정상적으로 잘림
  없이 그려졌지만, 마지막 텍스트 줄과 버튼 줄 사이 여유 공간이 거의 0에 가까워
  보이는" 상태를, 사용자가 "바가 터미널을 잡아먹어서 잘렸다"고 인지했을
  가능성이 있다 — 특히 나머지 공간이 하필 작게 나오는 폰트 크기/화면
  높이에서는 체감 차이가 크다.
- **H2: 탭 전환 순간의 1프레임 과도 상태.** `fitIfVisible()`/ResizeObserver
  콜백 모두 페인트 이후 비동기로 도는 값이라, Home→세션 전환 첫 프레임에
  일시적으로 부정확한 크기가 잠깐 그려졌다가 다음 틱에 바로잡히는 경우가
  이론적으로 있을 수 있다. 이건 "지속되는 잘림"이라기보다 순간 깜빡임이라
  사용자 보고("bottom row(s) get clipped")와는 결이 다르지만 배제하려면
  실기기에서 재확인이 필요하다.
- **H3 (실제 글리프 잘림이라면 가장 유력한 후보, 미검증): xterm.js 자체의
  서브픽셀 반올림.** FitAddon과 xterm 내부 렌더러가 공유하는
  `_renderService.dimensions.css.cell.height`는 캔버스 측정값이라 소수점을
  가질 수 있다. 특정 devicePixelRatio/브라우저 확대 배율 조합에서 `rows *
  cellHeight`로 그려지는 실제 캔버스가 `.terminal-container`의 content-box
  높이보다 아주 조금(서브픽셀~1px) 더 크게 반올림되면, `.terminal-container`의
  `overflow: hidden`(Terminal.css:279)이 마지막 줄 아래쪽 몇 픽셀을 실제로
  잘라낼 수 있다. 이건 code-docker 쪽 컨트롤 바 로직과는 무관하게 xterm.js
  자체에 알려진 렌더링 함정 부류다. H1을 배제한 뒤 devtools로 확인해볼 1순위
  후보.

**실기기에서 확인해야 하는 것**: 잘림이 실제로 보고되는 순간, 브라우저
devtools로 (a) `.terminal-container`의 실제 content-box 높이(computed
style)와 `.xterm-screen`/캔버스의 실제 렌더링 높이를 나란히 재서 캔버스가
컨테이너보다 큰지(H3), 아니면 (b) 그냥 여백이 0에 가까워서 착시로 보이는
것인지(H1)를 구분할 것.

### 항목 2 — `TerminalControls.tsx`: 무엇이 있고, 데스크탑에서 뭘 잃는가

`TerminalControls.tsx`는 두 그룹을 렌더링한다:

1. `effectiveSettings.keybindings` 기반 커스터마이즈 가능한 특수키 버튼 —
   기본값(`keybindings.ts:17-27`)은 `Esc, Ctrl, Alt, Shift, Tab, ↑, ↓, ←, →`
   9개이고, 사용자가 설정 패널에서 자유롭게 추가/삭제/수정할 수 있다.
   Ctrl/Alt/Shift 셋은 바이트를 직접 보내는 게 아니라 "다음 입력에 적용되는
   sticky 모디파이어"로 동작한다(`armModifier`, Terminal.tsx:689-696).
2. 줌 아웃/인 버튼 — 커스터마이즈 목록과 별개로 `TerminalControls.tsx` 자체가
   고정 추가하는 항목(74-101행), 폰트 크기를 조절하고 상태는 기기별
   localStorage(`FONT_SIZE_STORAGE_KEY`)에 저장된다.

높이는 위에서 확인했듯 `flex-wrap: nowrap; overflow-x: auto`라 콘텐츠 양과
무관하게 **한 줄 고정**이다(넘치면 가로 스크롤).

데스크탑 사용자가 이 바를 숨기면 실질적으로 잃는 것: Ctrl/Alt/Shift 스티키
모디파이어, Tab, 화살표 4개, Esc — 전부 물리 키보드가 이미 그대로 가진
키들이라 데스크탑에서는 원래도 잉여 기능이다(모바일 가상 키보드에 없는 키를
보완하기 위한 바). 줌 버튼만 유일하게 "물리 키보드로 대체 불가능한" 실질
기능이라, 항목 3에서 그것만 별도로 옮기는 요구가 합리적이다.

### 항목 3 — 줌을 탭 행으로: `TerminalTabs.tsx` / `.terminal-tabbar`

**여기서 조사 전제와 다른 확정 사실 하나**: `.terminal-tabbar`는 가로
스크롤되지 않는다. 실제로는 **줄바꿈된다**:

```css
/* Terminal.css:65-73 */
.terminal-tabbar {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex: none;
  flex-wrap: wrap;
  margin-top: 0.5rem;
  border-bottom: 1px solid var(--border);
}
```

`overflow-x`가 어디에도 없다 — 탭이 많아지면 `.terminal-tabbar` 자체가 2줄,
3줄로 늘어나(그리고 `.terminal-surface`가 flex:1이라 그만큼 터미널 영역이
줄어든다 — 이것도 하드코딩 없이 flex로 자동 처리됨, 항목 1의 결론과 같은
매커니즘). "탭이 많아지면 가로 스크롤된다"는 조사 지시의 전제는 이 코드베이스
현재 상태와 다르다 — sticky 배치를 설계하기 전에 먼저 짚어야 할 부분.

이게 줌 이동 설계에 실질적으로 영향을 준다. `position: sticky`는 **스크롤
컨테이너** 안에서만 의미가 있는데, 지금 `.terminal-tabbar`는 스크롤되는 게
아니라 줄바꿈되는 컨테이너라 "옆으로 스크롤해도 오른쪽에 붙어있다"는 sticky의
효과 자체가 성립하지 않는다(줄바꿈 레이아웃엔 애초에 스크롤이 없다).

**구현 경로 두 가지 (트레이드오프):**

- **(A) 탭 바를 가로 스크롤로 바꾸고 그 안에서 sticky.** `.terminal-tabbar`를
  `flex-wrap: nowrap; overflow-x: auto`로 바꾸고, 줌 그룹을 그 안의 마지막
  flex 자식으로 두고 `position: sticky; right: 0`을 준다. 필요한 것:
  - 스크롤 컨테이너를 확립하는 건 `.terminal-tabbar` 자신(overflow-x:auto)
    — sticky 대상은 반드시 이 컨테이너의 직계 자식이어야 하므로, 지금처럼
    `<TerminalTabs>`가 모든 탭 + "+" 버튼을 렌더링하는 구조에 줌 그룹을 그
    "형제"로 넣으려면 `TerminalTabs.tsx`가 줌 콜백(`onZoom`)/토글 상태를
    새로 받아 자기 안에서 렌더링하거나, `.terminal-tabbar`를 렌더링하는
    책임 자체를 `Terminal.tsx`로 한 단계 끌어올려야 한다(`TerminalTabs`는
    탭 목록만 그리는 내부 div로 축소).
  - **불투명 배경 필수**: sticky 줌 그룹 뒤로 탭이 스크롤되어 지나가므로
    `background: var(--surface)`(또는 `--bg`, 탭 색과 맞춰서) 같은 명시적
    배경이 없으면 스크롤되는 탭 텍스트가 비쳐 보인다. 지금
    `.terminal-tabbar` 자체엔 배경이 없다(테두리만).
  - `z-index`로 탭들 위에 오도록.
  - 좁은 화면에서 탭이 아주 많으면 sticky 줌 그룹이 가용 폭을 계속 깎아먹는
    문제가 있다 — 아이콘만 남기는 등 자체 반응형 축소가 필요할 수 있음.
  - **드래그 재정렬/rename과의 충돌**: 줌 그룹은 `.terminal-tab`이 아니라
    별도 형제 엘리먼트이므로 `draggable`/`onDrop` 핸들러가 걸린 탭 엘리먼트들과
    구조적으로 섞이지 않는다 — 직접 충돌은 없어 보이지만, `.terminal-tab-add`
    ("+") 바로 옆에 sticky 요소가 오면 그 사이 드롭 타겟 판정 UX가 어색해질
    수 있어 실기기 확인 필요.
  - **행동 변화가 크다**: 탭이 많을 때 지금의 "줄바꿈되어 다 보인다"에서
    "가로로 숨겨져 스크롤해야 한다"로 바뀌는 것 자체가 이 작업의 스코프를
    넘어서는 UX 변경 — 저장소 소유자 확인 필요.

- **(B) 줄바꿈은 그대로 두고, 줌만 별도 비-줄바꿈 영역으로 분리.**
  `.terminal-tabbar`를 두 영역으로 나눈다: 왼쪽은 지금처럼 줄바꿈되는 탭
  목록(`flex-wrap: wrap`, 지금 그대로), 오른쪽은 절대 줄바꿈되지 않는
  줌 버튼 그룹(`flex: none`, `margin-left: auto`로 오른쪽 정렬). "탭이
  아무리 늘어나도 줌은 항상 맨 오른쪽에 고정되어 보인다"는 사용자 요구의
  본질(눈에 잘 띄고, 늘 같은 자리)은 만족하지만, 스크롤이 없으므로 엄밀히
  `position: sticky`는 아니다 — 탭 바 자체가 다단으로 늘어나면 줌 그룹은 그중
  첫 줄 오른쪽에만 고정(다른 줄엔 탭만 흐름).
  - 기존 줄바꿈 동작을 안 건드리므로 회귀 위험이 훨씬 낮다.
  - `.terminal-tabbar`의 flex 레이아웃을 살짝 바꾸는 정도라 `TerminalTabs.tsx`
    쪽 구조 변경도 (A)보다 작다 — outer wrapper 하나만 추가.
  - 사용자가 명시적으로 "position-sticky"라고 표현했으므로, 정확히 그 단어의
    CSS 의미를 원하는 것인지(→ (A), 스크롤 필요) 아니면 "항상 같은 자리에 보임"
    이라는 결과만 원하는 것인지(→ (B), 더 간단) 확인이 필요.

두 경로 모두 줌 버튼 JSX/아이콘을 `TerminalControls.tsx`와 새 위치 양쪽에서
공유해야 하므로, `ZoomIn`/`ZoomOut` 버튼 쌍을 작은 공용 서브컴포넌트로 뽑아
`onZoom`(Terminal.tsx:647-657의 기존 `zoom` 콜백 재사용)만 주입받게 하는 편이
중복을 피한다.

### 항목 2 연장 — 기기별 토글 설계

기존 관례 3종(`mobileInputWorkaroundEnabled`, `altScreenTouchScrollEnabled`,
`autoReconnectEnabled` — 전부 Terminal.tsx의 `load*`/`save*` localStorage 헬퍼 +
`TerminalSettingsPanel.tsx` 체크박스 쌍)을 그대로 따르면 된다. 이 중
**`autoReconnectEnabled`가 정확한 모델**이라는 지시가 맞다 — 이유:

- `mobileInputWorkaroundEnabled`는 xterm 생성 이펙트(deps `[]`, Terminal.tsx:735
  부근)에서 **한 번만** 읽혀 터치 디바이스 입력 필드를 만들지 말지를 결정하므로,
  토글해도 탭을 나갔다 들어와야 반영된다.
- `autoReconnectEnabled`는 ref로 미러링되어(`autoReconnectEnabledRef`,
  Terminal.tsx:279-280) 이미 걸려있는 리스너/조건문에서 **즉시** 반영된다.
- 컨트롤 바 표시 여부는 `activeSession !== HOME_TAB_ID && <TerminalControls
  .../>`(Terminal.tsx:1575) 같은 **평범한 조건부 렌더**라서, 애초에 ref 미러링도
  필요 없다 — plain state 하나(`controlBarEnabled` 같은 이름)를 조건에
  `&&`로 추가하기만 하면 매 렌더마다 자연히 즉시 반영된다. 그리고 항목 1에서
  확인했듯 컨트롤 바가 사라지면 `.terminal-container`가 flex로 자동으로 그
  공간을 흡수하고 ResizeObserver가 이를 잡아 `fitAddon.fit()`을 다시 부르므로,
  숨김/표시 전환 시 xterm 리사이즈를 위해 추가로 짤 코드가 없다 — 이미 있는
  메커니즘에 그냥 올라탄다.

**필요한 것 (요약)**:
- `Terminal.tsx`에 `CONTROL_BAR_KEY` + `loadControlBarEnabled`/
  `saveControlBarEnabled` 헬퍼 (기존 3종과 동일한 try/catch 패턴).
- `[controlBarEnabled, setControlBarEnabledState]` state + `toggleControlBarEnabled`
  콜백 (autoReconnectEnabled와 동일 모양, ref는 불필요).
- 렌더 조건: `activeSession !== HOME_TAB_ID && controlBarEnabled &&
  <TerminalControls .../>` — 숨겨졌을 때 줌 버튼을 항목 3의 새 위치로 옮기는
  로직과 반드시 짝을 맞출 것 (바가 꺼지면 줌 접근 경로 자체가 없어지면 안 됨 —
  이게 항목 3이 요구되는 이유이기도 함).
- `TerminalSettingsPanel.tsx`에 새 섹션(체크박스 1개, 다른 3종과 같은
  `checkbox-option` 마크업) + props 3개(`controlBarEnabled`,
  `onToggleControlBarEnabled`) Terminal.tsx → TerminalSettingsPanel로 스레딩.

**기본값**: 지시대로 `pointer: fine`이면 기본 숨김을 권장한다. 이미 이
파일에 같은 API로 터치 판별하는 선례가 있다:

```js
// Terminal.tsx:894-897 (isTouchDevice, 별도 관심사지만 같은 API)
const isTouchDevice =
  loadMobileInputWorkaroundEnabled() &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches
```

대칭적으로 `window.matchMedia('(pointer: fine)').matches`를 기본값 산출에
쓰면 된다: localStorage에 저장된 값이 없을 때만 `!matchMedia('(pointer:
fine)').matches`로 기본을 정하고(정밀 포인터=마우스/트랙패드면 기본 숨김,
그 외엔 기본 표시 — matchMedia 미지원 환경은 지금 동작을 안 바꾸는 쪽인
"표시"로 안전하게 폴백), 사용자가 한 번이라도 명시적으로 토글하면 그 값을
기기별로 계속 따르게 한다(다른 3종과 동일 패턴). 유의할 점: `pointer:
fine`/`pointer: coarse`는 **주 입력 장치** 기준이라, 마우스+터치스크린을 함께
쓰는 하이브리드 랩톱 같은 경우 브라우저 판정이 기기마다 다를 수 있음 — 실기기
확인 대상.

## 수정 방향 요약

| 항목 | 방향 | 트레이드오프 |
|---|---|---|
| 1. 잘림 | 코드상 하드코딩된 높이 가정은 없음(확인됨) — H1(여백 없음 착시)이 사실이면 CSS 쪽에 `.terminal-container` 하단에 아주 작은 패딩/그림자를 추가해 시각적 여유를 주는 정도로 충분할 수 있음. H3(캔버스 반올림)가 사실이면 xterm.js 쪽 이슈라 code-docker에서 완전히 고치기 어려울 수 있고, `.terminal-container` 쪽에 1px 여유 패딩을 더 주는 정도의 우회가 최선일 수 있음 | 실기기로 H1/H3 구분 전엔 어느 쪽도 확정할 수 없음 — 코드만 보고 고치면 헛다리 짚을 위험 |
| 2. 데스크탑 숨김 토글 | `autoReconnectEnabled` 패턴 그대로 이식(즉시 반영, ref 불필요) | 없음 — 이미 있는 관례+메커니즘에 얹는 것이라 리스크 낮음 |
| 3. 줌 이동 | (A) 탭 바를 스크롤 컨테이너로 바꾸고 진짜 `position: sticky`, 또는 (B) 탭 바 줄바꿈은 유지하고 줌만 비-줄바꿈 우측 고정 영역으로 분리 | (A)는 사용자가 말한 단어("sticky") 그대로지만 지금 탭 바의 줄바꿈 동작 자체를 스크롤로 바꾸는 더 큰 변경 — 소유자 확인 필요. (B)는 더 작은 변경이지만 엄밀한 sticky는 아님 |

## 아직 실기기 확인이 필요한 것

1. 실제로 보고된 잘림이 글리프가 물리적으로 잘리는 것(H3)인지, 여백이 거의
   없어 보이는 착시(H1)인지 — devtools로 `.terminal-container` content-box
   높이 vs 실제 캔버스 렌더링 높이 비교.
2. Home→세션 전환 순간 1프레임 과도 상태(H2)가 실제로 관찰되는지.
3. `pointer: fine`/`pointer: coarse` 판정이 저장소 소유자의 실제 기기
   구성(특히 터치스크린 랩톱처럼 하이브리드가 있다면)에서 기대대로 나오는지.
4. 탭 바를 "줄바꿈"에서 "가로 스크롤"로 바꾸는 (A) 방향을 실제로 원하는지,
   아니면 지금 줄바꿈 동작은 유지한 채 줌만 고정하는 (B)로 충분한지 — 이건
   실기기 확인이라기보다 소유자 의사결정이지만 착수 전 반드시 필요.
5. (A)를 택할 경우, 탭이 아주 많을 때 sticky 줌 그룹과 "+" 버튼/드래그
   드롭존 사이 UX가 실기기(특히 터치)에서 어색하지 않은지.
