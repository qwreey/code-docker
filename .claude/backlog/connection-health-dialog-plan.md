# 연결 상태 진단 다이얼로그 (아이디어 정리 — 구현 전, 사용자 노트 원문 기반)

2026-08-10, 사용자가 다른 여러 요청과 함께 남긴 노트를 정리한 문서. router의
경계 구조를 건드리는 항목이라 다른 급한 항목들을 먼저 처리하느라 이번
라운드엔 착수하지 않음 — 구현 전 설계 스케치 + 착수 시 확인해야 할 지점
정리 용도.

## 동기

code-server가 커넥션이 끊기면 vscode 기본 UI인 "cannot reconnect please reload
the window" 다이얼로그가 뜨는데, 이게 왜 끊겼는지("router가 요청을 못
받았나? code-docker 안 nginx조차 요청을 못 받았나? 아니면 code-server 프로세스
자체가 죽었나?") 아무 정보도 안 줌. 또한 연결이 복구돼도 자동으로 리로드
해주지 않고, 그냥 계속 저 다이얼로그만 떠 있음.

## 요청 사항 정리

1. **항상 200을 응답하는 헬스체크 엔드포인트**를 code-docker 자체 nginx와
   router 양쪽에 둘 것 — "이 계층까지는 살아있다"를 구분해서 알 수 있게.
2. 프론트엔드(code-server 페이지 위)에 **연결 상태 진단 다이얼로그**를 추가:
   - 화면 상단 중앙(또는 임의 위치)에 표시.
   - **router의 tailscale 로그인 안내 다이얼로그보다 항상 위(z-index 최상위)**에
     와야 함 — `config/code/code-patch/tailscale-notify.default.js`가 쓰는
     `window.CDDialog` 스택 규칙 참고.
   - 폴링 주기는 평상시 약 10초, **연결이 끊긴 상태에서는 반응성을 위해 3~5초로
     단축**.
   - router 계층 / code-docker nginx 계층 / code-server 프로세스 자체 중 어디까지
     응답하는지 구분해서 보여줌.
   - 연결이 복구되면(다시 정상 응답) — vscode 기본 리로드 다이얼로그는 "언제
     복구될지 안내가 없는 채로 계속 떠 있기만" 하는 문제가 있으므로, 이 새
     다이얼로그가 "연결이 복구됐습니다, 새로고침하세요" 안내를 추가로 띄워줌.

## 설계 스케치

### 헬스체크 엔드포인트

- code-docker 자체 nginx(`config/nginx/nginx.default.conf`)에 고정 200을
  반환하는 `location`을 하나 추가 (예: `/_healthz` — 기존
  `/_code_not_ready.html`류 네이밍과 통일). nginx 레벨에서 처리되므로 code-server
  프로세스가 죽어 있어도 이 계층이 살아있으면 200이 나옴 — 이게 핵심: nginx
  응답 여부와 code-server 응답 여부를 분리해서 볼 수 있게 하는 게 이 엔드포인트의
  존재 이유.
- router 쪽 nginx(`router/config/nginx/nginx.default.conf`)에도 동일한 개념의
  엔드포인트 추가. router는 인터넷(또는 상위 tailnet)에서 code-docker까지
  가는 경로의 앞단이므로, "router까지는 도달했다"를 구분하는 신호가 됨.

### 프론트엔드 진단 로직

브라우저에서 세 계층을 순서대로(혹은 병렬로) 폴링:
1. router의 헬스체크 — 실패 시 "router에 도달하지 못함"(네트워크 자체 문제 또는
   router가 죽음).
2. code-docker nginx의 헬스체크 — router는 응답하는데 이게 실패하면 "code-docker
   컨테이너 자체가 응답하지 않음".
3. code-server 자체의 살아있음 신호 — nginx는 응답하는데 code-server 프로세스가
   죽어 있으면 이 마지막 계층에서만 실패. code-server 자체엔 이미 표준 상태
   엔드포인트가 있을 가능성이 있음(vscode-web/code-server 자체 헬스체크 유무는
   착수 시 재확인 필요 — 없으면 nginx가 code-server로 프록시하는 실제 경로 중
   하나를 살아있음 신호로 재사용).

세 계층의 성공/실패 조합으로 "어디까지 살아있는지" 메시지를 구성.

### 표시/스타일링

- `config/code/code-patch/`에 새 patch 스크립트로 추가 (기존
  `tailscale-notify.default.js`/`router-auth-notify.default.js`와 같은 위치,
  같은 패턴 — 상태를 폴링해서 렌더링하는 기존 위젯 컨벤션,
  `.claude/backlog/code-patch-widgets.md` 참고).
- `window.CDDialog`를 재사용할 수 있을지, 아니면 z-index를 확실히 최상위로
  보장하기 위해 별도 오버레이가 필요한지는 착수 시 `CDDialog`의 현재 z-index
  스택 규칙을 직접 확인 후 결정.
- 복구 알림은 "새로고침" 버튼이 있는 별도 배너/토스트로 — 자동 새로고침은
  사용자가 입력 중인 상태를 날릴 수 있으므로 하지 않음(명시적으로 사용자가
  요청한 것도 아님, vscode 기본 동작도 자동 새로고침은 안 함).

## 미해결 질문

1. code-server 자체의 "살아있음" 신호로 뭘 쓸지 — 전용 헬스체크 경로가 이미
   있는지, 아니면 nginx가 이미 프록시하는 정적 리소스 하나를 재사용할지 확인
   필요.
2. `window.CDDialog`가 z-index 우선순위를 이미 어떻게 관리하고 있는지(여러
   배너 동시 표시 시 순서) — 재사용 가능한지 새 규칙이 필요한지 착수 시 확인.
3. router 자체가 완전히 죽었을 때(컨테이너 자체가 내려감) 브라우저가 router의
   헬스체크에 어떻게 도달하는지 — router가 살아있어야 그 경로 자체가 열려
   있는 구조라, "router가 죽음"과 "네트워크 자체가 끊김"을 프론트엔드에서
   구분할 수 있는지는 불확실 (둘 다 단순히 fetch 실패로만 보일 수 있음) — 이
   경우 메시지를 "router 또는 그 이전 구간에 문제가 있어 보입니다" 정도로
   뭉뚱그리는 선에서 타협해야 할 수 있음.

## 참고

- `config/code/code-patch/tailscale-notify.default.js`,
  `router-auth-notify.default.js` — 기존 폴링 기반 위젯 패턴.
- `.claude/backlog/code-patch-widgets.md` — `CDDialog` 계열 공통 컴포넌트
  아이디어, 재사용 가능성 있음.
- 루트 `CLAUDE.md`의 "router" 절 — router/nginx/code-docker 경계 구조 전반.
