# URL 상태(세션/폴더/프로젝트) + 파일 브라우저 오버레이 + 전체화면 에디터 — 구현 완료

2026-09-06. **코드/빌드 검증 완료, 사용자 QA만 남음.** 사용자 요청 4번/8번.

## 배경

- 탭(섹션)만 URL(pathname 마지막 세그먼트)에 있었고, **탭 안의 상태는 하나도 없었다.**
  새로고침하면 터미널은 항상 홈 탭으로, 파일 매니저는 홈 폴더로, 프로젝트 상세 시트는
  닫힌 채로 돌아갔다. 북마크도 불가능.
- 터미널에서 에이전트가 파일을 써놓고 "이거 봐 달라"고 하면 파일 탭으로 이동 →
  확인 → 다시 터미널로 복귀가 필요했다. 사용자 표현: "그 왕복 동작이 많이 복잡해져".
- 파일 편집은 바텀 시트(공용 `Sheet`의 모바일 변형)로 열려서, 키보드가 올라오면
  실제 내용이 보이는 영역이 거의 안 남았다. 줄바꿈 토글도 없어서 md 같은 긴 줄은
  가로 스크롤로 봐야 했다.

## URL 상태 (`?session=` / `?path=` / `?project=`)

`App.tsx`에 `writeQuery(key, value)` 하나. **`replaceState`이지 `pushState`가 아니다** —
탭 안에서 클릭할 때마다 히스토리 항목을 쌓으면 브라우저 뒤로가기가 파일 매니저에선
"상위 폴더로", 터미널에선 "이전 세션으로"가 되어버린다. 이 앱 어디서도 뒤로가기는
그런 뜻이 아니다. 탭을 바꾸면 `setActive`가 `rootPath + id`를 push하므로 쿼리는 자연히
사라진다(파일 탭에 `?session=`이 남아 있을 이유가 없다).

각 탭이 자기 상태를 위로 보고하는 콜백을 새로 받는다:

| 탭 | 보고 | 복원 |
|---|---|---|
| Terminal | `onActiveSessionChange` | `restoreSession` prop |
| Files | `onPathChange` | 기존 `initialPath` 재사용 |
| Projects | `onSelectedProjectChange` (→ `ProjectTable`의 `detailsPath`) | 기존 `initialProjectPath` 재사용 |

**터미널 복원만 별도 경로다.** 기존 `initialOpen.session`은 항상 "다른 탭이 방금 본
살아있는 세션"이라 그대로 `selectSession` 해도 됐지만, URL에서 온 이름은 죽었을 수
있다. 그런데 세션은 **WS 핸드셰이크가 lazy하게 만든다** — 별도 create 엔드포인트가
없다. 그래서 없는 이름을 그냥 선택하면 **조용히 새 셸이 생긴다**: 죽은 북마크를 열
때마다 프로세스가 하나씩 늘어난다. 그래서 `restoreSession`은 `refreshSessions()`
결과와 대조해서 **있을 때만** 선택하고, 없으면 홈 탭에 그대로 둔다(사용자 요구
그대로).

## 파일 브라우저 오버레이 (`FileManagerDialog`)

`ProjectInfoDialog`와 같은 모양·같은 이유. 터미널 상단의 "파일 브라우저에서 열기"가
이제 탭 이동 대신 **현재 탭 위에 전체화면 다이얼로그**를 연다. 안에 "탭으로 열기"
버튼이 있어서 계속 볼 거면 원래대로 넘어갈 수 있다.

- `FileManager`에 `embedded` prop 추가 — 다이얼로그 헤더가 이미 제목이라 페이지
  `<h1>`/설명은 세로 공간만 먹는다
- Projects 탭의 "파일 매니저에서 열기"는 **그대로 탭 이동**이다. 거기선 원래 목적지가
  파일 탭이므로 오버레이가 이득이 없다

## 공용 `Sheet`에 전체화면 변형 추가

`size="full"` (+ `bodyClassName`). 내용 자체가 하나의 화면인 경우(파일 브라우저,
코드 에디터)에 쓴다 — 기본 760px 카드 + 모바일 키보드 조합이 실제 내용을 거의 다
잡아먹던 게 이 요청의 출발점이다. 폼 성격의 기존 시트들은 건드리지 않았다.

## 파일 에디터: 전체화면 + 줄바꿈 토글

- `FileEditorSheet`가 `size="full"` + `bodyClassName="sheet-body-flush"`, 에디터 높이는
  `60vh` 고정에서 `100%`로. 퍼센트 높이가 실제로 풀리려면 부모가 패딩/스크롤을 갖지
  않아야 해서 flush body가 필요했다
- 헤더에 줄바꿈 토글. `CodeEditor`에 `wrap` prop을 추가하고 CodeMirror
  `Compartment`로 `EditorView.lineWrapping`을 live reconfigure — 기존
  language/readOnly/theme 컴파트먼트와 같은 패턴이라 에디터를 다시 만들지 않는다
- 상태는 `localStorage`의 `webmanager.files.editorWrap`, **기본값 켬**. 이 에디터를
  가장 많이 여는 곳이 폰이고, 거기서 긴 줄을 가로 스크롤로 읽는 게 원래 불만이었다

## code-server 위젯 → 새 탭 (요청 8번 후반)

`config/code/code-patch/webmanager-launcher.default.js`의 헤더에 "새 탭으로 열기"(↗)
버튼 추가. `MANAGER_URL`이 아니라 **iframe의 현재 `location.href`**를 읽어서 연다 —
위에서 만든 URL 상태 덕분에 보고 있던 세션/폴더/프로젝트 그대로 새 탭에 뜬다.
동일 출처라 읽을 수 있고, 아니면 base URL로 폴백한다.

## 사용자 QA 항목

`.claude/qa-checklist.md` 참고.

## 브라우저로 실제 측정한 것 (2026-09-06)

`http://yaeji-laptop/manager`에 붙어서 확인:

- 세션 선택 → `?session=%EC%84%B8%EC%85%98+1` 붙음 → 새로고침 → 같은 세션 재연결(`연결됨`)
- **`?session=nope-does-not-exist`로 진입 → 홈 탭, 새 세션 안 생김, 쿼리도 정리됨** (핵심 요구사항)
- 폴더 이동 → `?path=%2Fcode%2F.config` → 새로고침 → 같은 폴더
- 프로젝트 상세 열기 → `?project=%2Fcode%2FProjects%2Ftest` → 새로고침 → 시트 다시 열림
- 터미널에서 파일 브라우저 오버레이 → `sheet-content sheet-content-full`, 뷰포트 전체,
  `.sheet-body h1` 없음(중복 제목 없음), 뒤에 `.terminal-section` 살아 있음
- 오버레이의 "탭으로 열기" → `/manager/files?path=%2Fcode`
- 파일 편집기 → 전체화면, CodeMirror 높이 961px, 줄바꿈 토글 양방향 동작
  (`cm-content cm-lineWrapping` ↔ `cm-content`), localStorage에 저장됨
- 터미널 햄버거 버튼: DOM에 존재, 데스크탑에선 `display: none`, `@media (max-width: 720px)`
  규칙이 `inline-flex`로 켬 — 실제 모바일 폭 확인은 사용자 몫

**이 과정에서 진짜 버그를 하나 잡았다.** 처음엔 "탭으로 열기"가 다이얼로그만 닫고
탭을 안 바꿨다. 원인은 내 코드가 아니라 `utils/viewTransition.ts`였다 —
`document.hidden`인 문서에서 `startViewTransition()`은 abort되면서
**업데이트 콜백 자체를 미룬다.** 그 안에 `flushSync(update)`가 있으니 상태 변경이
아예 안 나가고, 나중에 다른 트랜지션이 시작될 때서야 밀려서 실행된다(그래서 "가끔
되는" 것처럼 보였다). `document.hidden` 가드를 추가해서 고쳤고, 이건
`.claude/browser-qa-notes.md`에 오래 적혀 있던 "사이드바 클릭이 가끔 라우팅을 안
탄다"의 정체이기도 하다.
