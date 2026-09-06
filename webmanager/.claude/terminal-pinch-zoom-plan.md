# 터미널 두 손가락(핀치) 확대/축소 — 조사 결과 + 구현안

작성 2026-09-06. **착수 전. 사용자 요청은 "부작용 없이 가능한지 조사만" 이었음.**

결론부터: **가능하고, 예상보다 부작용이 적다.** 두 손가락 제스처 슬롯이 지금
완전히 비어 있고(아래 참고), 폰트 크기 확대/축소 로직 자체는 이미 다 있어서
새로 만들 게 "제스처 → 이미 있는 `zoom()` 호출" 한 겹뿐이다. 다만 실기기에서만
드러나는 함정이 세 개 있어서 그것들을 아래에 정리해둔다.

## 지금 상태 (코드로 확인)

- 터치 핸들러는 `Terminal.tsx`의 xterm 생성 이펙트 안에 있고(`onTouchStart` /
  `onTouchMove`, `container`= `.terminal-container`에 등록), **둘 다 첫 줄이
  `if (e.touches.length !== 1) return` 이다.** 즉 손가락이 두 개가 되는 순간
  터미널 쪽 로직은 전부 손을 뗀다 — 두 손가락 제스처는 지금 **아무 동작도
  하지 않는다.** 새 기능이 뺏어올 기존 동작이 없다는 뜻이라, 이게 "부작용
  없이 가능한가"에 대한 가장 중요한 답이다.
- `touchmove`는 이미 `{ passive: false }`로 등록돼 있어서 `preventDefault()`를
  부를 수 있다. 리스너 옵션을 바꿀 필요가 없다.
- `.xterm-screen`에 `touch-action: none`이 걸려 있다(`Terminal.css`). 브라우저
  자체 핀치 줌은 글자 영역 위에서는 이미 죽어 있다 — **즉 지금도 터미널 안에서
  두 손가락으로 확대하면 아무 일도 안 일어난다.** 이 기능은 "브라우저 줌을
  빼앗는" 게 아니라 "이미 죽어 있는 제스처에 의미를 주는" 쪽이다.
- 폰트 크기 파이프라인은 완성돼 있다: `FONT_SIZE_STORAGE_KEY`(기기별
  localStorage), 8~32 정수 클램프, `zoom(direction)` 콜백, 그리고 `fontSize`가
  바뀌면 `term.options.fontSize` 반영 → `fitIfVisible()` → `sendResize()`까지
  도는 이펙트. 제스처는 여기에 그냥 얹으면 된다.

## 구현안

`onTouchStart`/`onTouchMove`에 두 손가락 분기를 추가한다. 기존 1-손가락 경로는
건드리지 않는다(early-return 조건이 `!== 1` 그대로라 자연히 분리된다).

```
onTouchStart:
  e.touches.length === 2 이면
    pinchStartDist = 두 터치 사이 거리
    pinchStartFontSize = 현재 fontSize
    dragging = false            // 1-손가락 스크롤 상태를 확실히 끊는다
onTouchMove:
  e.touches.length === 2 이고 pinchStartDist > 0 이면
    ratio = 현재거리 / pinchStartDist
    next = clamp(round(pinchStartFontSize * ratio), 8, 32)
    next !== fontSize 이면 setFontSize(next)   // 저장은 제스처 끝에서 1회
    e.preventDefault()
onTouchEnd/onTouchCancel (지금은 없음 — 새로 등록해야 함):
  손가락이 2개 미만이 되면 pinchStartDist = 0, 최종 크기를 localStorage에 저장
```

**앵커를 시작 거리/시작 폰트 크기로 잡는 이유**: 프레임마다 이전 값에 곱하는
누적 방식은 정수 클램프(8~32) 때문에 반올림 오차가 쌓여서, 손가락을 벌렸다
그대로 되돌려도 원래 크기로 안 돌아온다. 시작점 기준 비율이면 왕복이 정확히
왕복이 된다.

**필요한 리팩터**: 지금 `zoom()`은 "한 단계씩"이라 제스처엔 안 맞는다. 절대값
setter(`setFontSizeClamped(n)`)를 하나 빼서 `zoom()`과 핀치가 같이 쓰게 한다.
localStorage 저장은 그 setter가 아니라 제스처 종료 시점에 한 번만(중간 프레임
마다 쓰면 낭비).

## 실기기에서만 드러날 함정 3가지

1. **`.terminal-container`의 패딩 영역.** `touch-action: none`은 `.xterm-screen`
   에만 걸려 있는데 터치 리스너는 그 부모인 `.terminal-container`에 걸려 있다.
   두 손가락 중 하나가 패딩(또는 `.xterm-viewport` 스크롤바 자리)에서 시작하면
   브라우저 페이지 줌이 같이 발동할 수 있다. `preventDefault()`로 대부분
   막히지만, 확실히 하려면 `touch-action: none`을 `.terminal-container`까지
   올리는 게 맞다 — 다만 그러면 그 영역에서의 페이지 스크롤도 같이 죽으므로
   실제로 문제가 되는지부터 볼 것.
2. **iOS Safari.** iOS는 페이지 핀치 줌에 대해 `touch-action`/`preventDefault`를
   존중하지 않는 경우가 있고, 대신 비표준 `gesturestart`/`gesturechange`
   이벤트를 준다. 안드로이드만 쓴다면 무시해도 되지만, iOS도 대상이면 그쪽
   이벤트로 별도 분기가 필요하다. **아이패드에서 확인 필요.**
3. **리사이즈 폭풍.** `fontSize`가 바뀔 때마다 `fitAddon.fit()`과 WS `resize`
   프레임이 하나씩 나간다(둘 다 디바운스 없음 — `sendBytes`/`sendResize` 어디에도
   배칭이 없다). 폰트 크기는 정수 8~32라 제스처 하나당 최대 24번이라 치명적이진
   않지만, `fit()`은 xterm 전체 리플로우라 저사양 기기에서 체감될 수 있다.
   `requestAnimationFrame` 1개로 합치는 정도면 충분하다.

## 다른 작업과의 관계

- **터치 모드 선택(스크롤/마우스/선택)**과 겹친다. 어느 모드든 두 손가락은
  항상 핀치 줌이어야 한다 — 모드 분기는 1-손가락 경로 안에서만 하고, 2-손가락
  분기는 모드보다 바깥에 두는 게 맞다.
- 하단 컨트롤 바의 줌 버튼(`TerminalControls.tsx`) / 탭 줄의 `.terminal-zoom-group`
  (`TerminalTabs.tsx`)은 그대로 둔다. 핀치는 추가 경로이지 대체가 아니다
  (물리 키보드 기기, 접근성).
