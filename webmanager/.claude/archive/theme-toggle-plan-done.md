# Light/Dark 수동 토글 + 사이드바 하단 상태 바 — 구현 완료

## 업데이트 (2026-08-03, 두 번째 라운드): UI 다듬기 — 아이콘 + TTL 표시

- **레이아웃 재구성**: 3-way 세그먼트 버튼(자동/라이트/다크 텍스트 3개) →
  **아이콘 하나로 순환**하는 단일 버튼(`Monitor`/`Sun`/`Moon`, 클릭할 때마다
  자동→라이트→다크→자동 순환) + 오른쪽 고정(`margin-left: auto` — 왼쪽 잠금
  상태가 없어도 항상 오른쪽 끝). 잠금 상태는 왼쪽. `lucide-react` 새 의존성
  도입(`terminal-plan-done.md`의 탭 핀 아이콘과 공유).
- **잠금 상태에 남은 시간 표시** — 예전엔 "필수 아님"으로 남겨뒀던 TTL
  카운트다운을 실제로 구현. 백엔드 `GET /api/auth/status`가 이제
  `unlockedUntil`(RFC3339, 잠금 해제 상태일 때만) 필드를 추가로 내려줌 —
  `internal/authgate`에 `sessionStore.validUntil`/`Gate.UnlockedUntil` 추가
  (기존 `valid`/`Unlocked`은 이걸 감싸는 얇은 래퍼로 재작성, 동작 안 바뀜).
  프론트는 그 값으로 "N분 남음"을 계산해서 30초마다 재계산(초 단위 실시간
  카운트다운까지는 불필요 — 10분짜리 TTL에 분 단위면 충분하다고 판단).
  잠긴 상태면 `Lock` 아이콘 + 클릭 시 `requestUnlock()`, 풀린 상태면
  `LockOpen` + 남은 시간 텍스트(비활성).

`go build`/`go vet`/`gofmt`, `npm run build`/`npm run lint` 클린. 헤드리스
브라우저로 테마 순환(클릭 2번 → dataset.theme/localStorage 값 직접 확인),
아이콘 렌더링 직접 확인.

**이 문서는 끝난 기능임 — 재설계/재구현 필요 없음.**

## 요약

착수해보니 "토글 배선"보다 큰 작업이었음 — `index.css`에 다크 모드 값
자체가 아예 없었음(`prefers-color-scheme`가 앱 전체에서 딱 3개 차트 CSS
파일에만 있었고, 배경/테두리/텍스트/뱃지 같은 기본 UI는 다크 OS 설정에서도
그냥 라이트로 렌더링되고 있었음). 그래서 이번 작업의 실체는 "다크 모드를
처음 만들고, 그 위에 수동 토글을 얹는 것"이었음.

## 컬러 시스템 (`index.css`)

`dataviz` 스킬 로드해서 확인해보니, 이미 앱에 있던 `--viz-cat-1/2/3`
(파랑/주황/아쿠아) 값이 그 스킬의 검증된 레퍼런스 팔레트 1~3번 슬롯과 정확히
일치(과거 세션에서 이미 그 팔레트를 썼던 것으로 보임) —
`scripts/validate_palette.js`로 새 다크 서페이스(`#171a20`) 기준 재검증해서
통과 확인. 3단 캐스케이드로 정리(스킬의 레퍼런스 팔레트 문서가 보여준 패턴
그대로 재사용):
1. `:root` — 라이트 기본값(기존 그대로)
2. `:root[data-theme="dark"]` — 사용자가 명시적으로 다크를 고르면 OS 설정과
   무관하게 강제
3. `@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) {...} }`
   — OS가 다크인데 사용자가 명시적으로 "라이트"를 고르지 않았을 때만 적용

기본 UI 토큰(bg/surface/border/text/accent) 다크 값은 새로 설계(기존 라이트
팔레트의 차가운/블루 그레이 톤 유지 — dataviz 스킬의 웜 그레이 차트 크롬과는
의도적으로 분리, 앱 정체성과 차트 잉크가 다른 톤이어도 무방하다고 판단).
뱃지(`--color-green/red/yellow/gray-*`)도 다크 버전 새로 만듦(원래 전혀
없었음).

`--viz-cat-1/2/3`과 `--viz-seq-0..4`("표준" 버전)는 `index.css`로 중앙화하고,
`ClaudeCode.css`/`Processes.css`/`ResourceHistory.css` 3개 파일에 있던 동일
값 재선언 + 각자의 `prefers-color-scheme` 블록을 전부 제거. **단,
`Processes.css`의 CPU 히트맵이 쓰던 "muted" seq 변형(의도적으로 더 차분한
톤)은 진짜 variant라 그대로 로컬 오버라이드로 남김** — 위 3단 캐스케이드를
거기도 동일 적용(기존엔 naive `@media`만 있어서 사용자가 수동으로 "라이트"를
골라도 OS가 다크면 여전히 다크 색이 나오는 버그가 있었음, 같이 고침).

**Terminal은 의도적으로 그대로 둠** — `--term-bg`/`--term-fg`는 앱 테마가
아니라 사용자가 고른 xterm 테마를 따라가야 하는 별개 개념이라 이 작업 범위
밖(자세히는 `terminal-plan-done.md`).

## 테마 토글 메커니즘

`src/theme.ts`(순수 함수, `localStorage` 읽기/쓰기 + `<html>`의
`data-theme` 속성 적용) + `src/useTheme.ts`(리액트용 래퍼, 재렌더 트리거).
`main.tsx`에서 React 마운트 **전에** 동기적으로 `initTheme()` 호출 —
`useEffect` 안에서 했으면 첫 페인트 이후에나 적용돼서 깜빡임 발생. 저장은
기기별 `localStorage`(서버 동기화 안 함 — "휴대폰은 라이트, 노트북은 다크").
**3-way(자동/라이트/다크)로 확정** — 2-way는 "다시 자동으로 돌아가는" 방법이
없어서 막다른 골목이 됨, GitHub/VSCode 등 흔한 패턴도 3-way.

## 잠금 상태 표시 + 미리 해제

`useAuthStatus`(공용 훅으로 분리, `RequiresUnlock.tsx`도 같이 리팩터링해서
중복 fetch 제거) + `api/client.ts`에 `requestUnlock()` 추가(기존 401
인터셉터가 쓰던 큐/모달을 그대로 재사용하는 "그냥 열기" 진입점, 원래
없었음). `required: false`(비밀번호 자체 미설정)면 상태 표시 숨김. **TTL
카운트다운은 안 함** — 백엔드 `AuthStatus` 타입에 만료 시각 필드가 없어서
지금 API로는 불가능(추가하려면 백엔드 확장 필요).

사이드바 구조도 손봄(`Layout.css`) — `overflow-y:auto`가 `.sidebar` 전체에
걸려있어서 탭 목록이 길어지면 하단 바까지 같이 스크롤되어 사라지는 문제가
있었음 — `.sidebar-list-wrap`으로 목록만 스크롤되게 분리, 하단 바는
`flex: none`으로 항상 고정.

## 검증 상태

`npm run build`/`npm run lint` 클린. 개발 서버 + 헤드리스 브라우저로 DOM/
computed style/기능(클릭 → localStorage/data-theme 반영 → CSS var 변경)
전부 확인, 정상 동작. **실제 데이터로 그려지는 요소(히트맵 셀, 뱃지 등)의
실제 색상은 백엔드 없이 확인 못 함** — CSS 변수 값 자체가 테마별로 올바르게
바뀌는 건 확인했지만, 실제로 칠해졌을 때 보기 좋은지는 도커에서 확인 필요.

## 참고

- `archive/authgate-plan-done.md` — 비밀번호 게이트 메커니즘.
- `terminal-plan-done.md` — 왜 터미널 색상이 이 작업 범위 밖인지.
