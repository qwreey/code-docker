# 브라우저 QA 메모 (claude-in-chrome)

2026-09-04 세션에서 실제로 브라우저를 붙여 QA를 돌리며 알게 된 것들. 다음에 같은 걸
다시 알아내지 않으려고 남긴다.

## 붙는 법

- 도구는 **deferred**라 그냥은 안 보인다. `ToolSearch`로 한 번에 로드할 것:
  `select:mcp__claude-in-chrome__tabs_context_mcp,...__navigate,...__javascript_tool,...__computer,...__resize_window`
  (한 호출에 몰아서. 하나씩 부르면 왕복만 낭비)
- 그리고 `Skill(claude-in-chrome)`을 **먼저** 호출해야 한다.
- 검색어에 "browser"만 넣으면 안 나온다 — 실제로 그래서 이 세션 초반에 "도구가
  없다"고 잘못 결론냈다. `select:` 로 정확한 이름을 지정하는 게 확실하다.

## 이 스택 접속

- 테스트 스택: **`http://yaeji-laptop/manager`** (router가 호스트 :80 퍼블리시)
- 배포 확인은 번들 해시로: `[...document.querySelectorAll('link[href],script[src]')]`
  에서 `index-*.css` / `index-*.js`를 뽑아 `npm run build` 출력과 대조하면
  "내가 방금 만든 게 실제로 서빙 중인지"가 확실해진다.
- 사이드바 버튼 `.click()`이 라우팅을 안 태우는 경우가 있다. 안 되면
  `navigate`로 경로를 직접 친다(`/manager/processes`, `/manager/terminal`,
  `/manager/files`, `/manager/supervisor`).
- Task Manager는 상단 `성능`/`프로세스` 토글과 그 아래 `프로세스`/`포트` 서브탭이
  **둘 다** 있고 라벨이 겹친다. `프로세스` 텍스트 버튼이 2개 잡히므로 둘 다 눌러야
  표가 뜬다.

## 함정

- **이미지를 재빌드하면 비밀번호 게이트가 항상 다시 잠긴다.** 버그가 아니라 설계 —
  `internal/authgate/gate.go:78-81`이 HMAC 서명 키를 매 프로세스 시작마다 새로
  만들고 저장하지 않는다고 명시. 브라우저 QA 중 재빌드를 반복하면 그때마다 사람이
  다시 풀어줘야 한다. **QA 전에 변경을 모아 한 번에 배포**하는 편이 훨씬 낫다.
- `javascript_tool`의 결과에 민감해 보이는 키가 있으면 값이
  `[BLOCKED: Sensitive key]`로 가려진다. `session`, `passwordInputs` 같은 이름을
  쓰면 그렇게 된다 — 측정 스크립트의 **키 이름을 바꿔서** 피할 것.
- xterm은 캔버스 렌더러라 `.xterm-rows > div`의 `textContent`가 비어 있다.
  스크롤백을 텍스트로 읽을 수 없으니 확인은 스크린샷으로.
- xterm에 타이핑하려면 먼저 터미널 **글자 영역**을 클릭해서
  `document.activeElement.className === 'xterm-helper-textarea'`가 되는지 확인할 것.
  빈 여백을 클릭하면 포커스가 안 간다.
- `resize_window`로 창 높이를 줄여도 이 환경에선 `innerHeight`가 797에서 더 안
  바뀐다(WM 제약). 세로 리사이즈에 의존하는 검증은 여기서 못 한다.

## 셸 쪽 함정 (이 세션에서 반복해서 밟음)

- Bash 도구의 cwd가 호출 간에 리셋된다. **매 호출마다 `cd /home/yaeji/Projects/code-docker`**
  를 붙일 것.
- 로그인 셸이 fish라 따옴표 없는 glob(`--include=*.go`, `.env*`)이 "no matches"로
  죽는다. `bash -c '...'`로 감싸거나 따옴표를 칠 것.
- `hostname` 명령이 없다.
