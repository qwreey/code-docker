# Light/Dark 수동 토글 + 사이드바 하단 상태 바 (구현 전 설계, 미착수)

## 요구사항 (사용자 설명)

- 지금은 각 컴포넌트가 개별적으로 `@media (prefers-color-scheme: dark)`를 써서
  시스템 설정을 따라가고 있음(확인 완료 — `data-theme`나 전역 토글은 아직 없음).
  이건 유지하되(기본값), **사이드바 맨 아래에 바를 만들어서 수동 전환 버튼**을
  추가.
- 저장은 `localStorage`로 — "휴대폰은 라이트, 노트북은 다크"처럼 **기기별로 다른
  선택**을 원하므로 서버 저장(계정 단위 동기화)은 오히려 안 맞음.
- 같은 하단 바에 **현재 비밀번호 게이트 잠금 해제 상태 표시**(잠김/풀림)와, 눌러서
  **미리 잠금 해제**할 수 있는 버튼도 같이 놓기(`GET /auth/status`가 이미 있고,
  `src/components/common/UnlockModal.tsx`의 잠금 해제 플로우도 이미 있음 — 이
  바는 그 둘을 사이드바에 상시 노출하는 역할).

## 설계 방향 (초안)

### 테마 전환

- 전역 `ThemeContext`(또는 훨씬 가벼운 방식 — `localStorage` 값 읽고 `<html>`/
  `<body>`에 `data-theme="light"|"dark"` 속성을 세팅하는 작은 훅 하나로도 충분,
  Context까지 필요할지는 착수 시 판단) 신설.
- **기존 컴포넌트별 `@media (prefers-color-scheme: dark)` 블록을 전부
  `[data-theme="dark"] &` 류의 속성 선택자와 공존시켜야 함** — 이게 이 작업의
  실질적인 몸통. 정확히는:
  - `data-theme` 속성이 아예 없을 때 → 기존처럼 `prefers-color-scheme`를 따름
    (시스템 기본값 유지).
  - `data-theme="dark"`/`data-theme="light"`가 명시적으로 있을 때 → 그 값을
    강제(시스템 설정 무시).
  - CSS로 이걸 깔끔하게 하려면 각 컴포넌트 CSS 파일의 다크 모드 규칙을
    `@media (prefers-color-scheme: dark) { ... }` 하나로 두지 말고,
    `:root[data-theme="dark"] .foo { ... }`를 별도로 추가(미디어 쿼리 규칙은
    그대로 "시스템이 다크인데 수동 설정이 없을 때"를 위해 남겨둠) — **이미 만들어진
    컴포넌트 수가 많아서(ClaudeCode, Processes/Performance, ResourceHistory,
    Terminal, FileManager 등 각자 자기 CSS에 다크 모드 규칙을 갖고 있음) 이 작업은
    한 파일이 아니라 여러 CSS 파일에 흩어진 반복 작업**이 될 걸로 예상 — 착수
    시점에 실제로 몇 개 파일에 `prefers-color-scheme`가 있는지 grep해서 범위
    가늠 필요.
  - 대안: CSS 커스텀 프로퍼티(`--bg`, `--text` 등, 이미 `common.css`에 있는 것으로
    보임)를 `:root`와 `:root[data-theme="dark"]`/`:root[data-theme="light"]`
    셋에서만 정의하고, 개별 컴포넌트는 전부 그 변수만 참조하도록 되어있다면 이
    작업이 실제로는 `common.css`(또는 전역 변수 정의 파일) 하나만 고치면 끝날 수도
    있음 — **착수 전에 먼저 확인할 것**: 각 컴포넌트가 정말 순수 CSS 변수만
    쓰는지, 아니면 컴포넌트별로 직접 색상 하드코딩 + 자체 미디어 쿼리를 쓰는지
    (둘 다 섞여 있을 가능성 높음, 실제로 열어봐야 앎).
- 사이드바 하단 바: 3-way 토글(시스템/라이트/다크) 또는 2-way(라이트/다크,
  "시스템 따라가기"는 둘 다 안 누른 초기 상태로 표현) — UX 판단, 후자가 더 흔한
  패턴(GitHub 등)이라 무난해 보임.

### 잠금 상태 표시 + 미리 해제

- `GET /auth/status`를 사이드바 마운트 시 폴링(또는 그냥 이벤트 기반 — 전역
  401 인터셉터가 잠금 해제를 성공시킬 때 상태를 갱신하도록 연결) — 잠겨있으면
  자물쇠 아이콘 + "잠김", 풀려있으면 "풀림"(+ 남은 시간? TTL이 10분이라 카운트다운
  UX도 고려할 만함, 필수는 아님).
- 클릭하면 `UnlockModal`을 직접 열 수 있게(현재는 401을 받아야만 자동으로 뜨는
  구조라, 사이드바에서 "미리" 여는 경로가 없음) — `UnlockModal`이 이미 큐 기반
  대기자 패턴으로 돼있다면(`waitersRef`) 그 큐에 빈 요청을 하나 넣는 식으로
  재사용 가능한지, 아니면 별도의 "그냥 열기" 진입점을 하나 더 노출해야 하는지
  `UnlockModal.tsx` 구현을 먼저 확인.
- `required: false`(비밀번호 자체가 설정 안 된 상태)면 이 상태 표시 자체를
  숨기는 게 맞아 보임(잠글 게 없는데 "잠김/풀림"을 보여줄 필요 없음).

## 남은 질문

- `data-theme` 리팩터링 범위(위 "대안" 문단 참고) — 착수 전에 실제 CSS 구조부터
  확인해야 정확한 작업량을 알 수 있음.
- 3-way(시스템/라이트/다크) vs 2-way 토글.
- 잠금 상태 표시에 남은 TTL 시간까지 보여줄지.

## 참고

- `.claude/authgate-plan-done.md` — 비밀번호 게이트 메커니즘.
- `src/components/common/UnlockModal.tsx`, `RequiresUnlock.tsx` — 재사용 대상.
