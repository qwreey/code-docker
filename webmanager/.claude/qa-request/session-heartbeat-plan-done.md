# 활성 세션(열린 브라우저 탭) 목록 — heartbeat 방식

> **구현 완료 (코드/빌드 검증)** — 아래 설계 그대로 구현됨: 백엔드
> `internal/sessionheartbeat`(store.go 대신 `sessionheartbeat.go` 한 파일 —
> 소규모 패키지라 굳이 분리 안 함), `main.go`에 라우트 2개 + GC 고루틴
> 등록, 클라이언트 패치 `config/code-patch/session-heartbeat.default.js`,
> 프론트엔드는 계획대로 새 사이드바 탭("열린 세션")으로 추가(`components/
> Sessions/Sessions.tsx` + UA 요약용 `uaSummary.ts`) — 기존 탭 하위 섹션이
> 아니라 새 탭을 선택함(어느 기존 탭도 "브라우저 탭 목록"이라는 개념과 자연스럽게
> 안 맞아서). `go build`/`go vet`/`npm run build`/`npm run lint` 전부 통과.
>
> **편차**: `client.ts`에 별도 래퍼 함수(`listSessions()` 같은)는 추가하지
> 않음 — 실제로 조사해보니 `client.ts`엔 애초에 그런 per-endpoint 래퍼가 하나도
> 없고(제네릭 `api.get/post/put/...`만 export), 모든 컴포넌트가 `api.get<T>('/path')`를
> 컴포넌트 안에서 직접 호출하는 게 기존 패턴이었음 — 그래서 `Sessions.tsx`도
> `api.get<OpenSession[]>('/sessions')`를 직접 호출하도록 맞춤(신규 wrapper를
> 추가하는 게 오히려 "기존 패턴을 따르라"는 지시와 어긋남). `Store`의 필드는
> unexported `entries map[string]Entry`, exported 반환 타입은 `Entry`(계획
> 문서의 `entry`를 `List()`가 패키지 밖으로 반환해야 하므로 대문자로 시작하게 함,
> `ID` 필드 추가 — JSON 응답에 프론트엔드 테이블 `key`용 id가 필요해서).
>
> **미확인/열린 질문**: `folder` 쿼리스트링이 워크벤치 부팅 후에도
> `location.search`에 실제로 남아있는지는 실컨테이너 없이는 확인 불가 —
> 아래 "열린 질문" 절 그대로 미확인 상태로 남음. 정적 코드 분석상 스크립트
> 최상단에서 즉시 캡처하도록 작성은 해뒀음.

**상태: 스코프 확정, 구현 착수.** `research/session-viewer-plan.md`가 막아뒀던
"세션이 뭘 가리키는지부터 불명확" 문제를, 그 문서의 옵션 1~4 중 아무것도
고르지 않고 **5번째 방식**으로 우회해서 해결함: code-server 자체의 연결
API를 조회하는 대신(옵션 2, 실현 가능성 불확실이라 막혔던 부분), **클라이언트가
스스로 UUID를 만들어 주기적으로 자기 신고(heartbeat)** 하는 방식. 사용자가
직접 이 방식을 스코프 확정해서 요청함 — 인터랙티브 확인 완료로 간주하고
`research/`에서 승격.

## 요구사항 (사용자 원문 요약)

- 지금 code-docker/webmanager에 브라우저로 접속해있는 탭들이 "어디를 열어놨는지"
  목록으로 보고 싶음. 보안 목적 아님(SSO/Authentik이 이미 앞단에 있음) —
  가시성/편의 목적.
- webmanager 존재 여부를 code-server 쪽에서 확인해서, 없으면 조용히 opt-out.
- 클라이언트: 로드 시 UUID(또는 랜덤 id) 생성 → 서버에 전송.
- 목록 조회 시 최근 1~10분 내 heartbeat만 필터링해서 보여줌.
- Heartbeat 주기 30초 (사용자가 "적정"이라고 판단한 값 — 트래픽/부하 관점에서
  더 늘려도 무방하다고 언급).
- 보내는 정보: 열려있는 폴더 정도만. IP는 신뢰 불가(터널/프록시를 거치므로)
  → 수집 안 함. 대신 브라우저 시그니처(User-Agent)는 포함.
- 10~30분마다 오래된 항목 GC.
- **이 대화에서 추가 결정**: 목록 조회(GET) 엔드포인트는 authgate로 잠근다.
  Heartbeat 수신(POST)은 code-server 쪽(로그인 없음, `auth: none`)에서
  익명으로 쏘는 거라 애초에 인증 수단이 없음 — 잠그면 기능 자체가 동작 안 하므로
  **POST는 열어두고 GET만 gate**, 이게 authgate의 기존 "read-open/write-gated"
  원칙과는 반대 방향이지만(여긴 GET이 민감하고 POST가 안전한 특이 케이스),
  타당한 이유가 있는 예외로 문서화해둠.

## 설계

### 클라이언트 (code-patch)

새 파일 `config/code-patch/session-heartbeat.default.js` — 기존
`config/code-patch/tailscale-notify.default.js`와 완전히 동일한 뼈대 재사용:

- 세션 id: `sessionStorage`에 저장(탭 단위 — 새로고침엔 유지, 새 탭/탭 닫고
  재오픈이면 새 id — "지금 열려있는 탭"이라는 개념과 정확히 일치).
  `crypto.randomUUID()` 사용.
- 열린 폴더: code-server가 `/?folder=<path>`로 워크스페이스를 여는 걸
  `webmanager/frontend/src/.../ProjectTable.tsx:108`에서 이미 확인함. 이
  패치 스크립트는 `<head>`에 주입돼 워크벤치 부팅보다 먼저 실행되므로
  (`code-server-autoinstall/start.sh`의 `apply_resource_inject`가 `<script>`
  태그를 `</head>` 직전에 심음), **스크립트 최상단에서 즉시**
  `new URLSearchParams(location.search).get('folder')`를 읽어 캡처해둘 것 —
  워크벤치가 나중에 `history.replaceState`로 쿼리스트링을 지울 가능성이
  있으므로 지연 없이 초기 실행 시점에 읽어야 함. **미확인 가정**: 실컨테이너에서
  이 값이 실제로 살아있는지 확인 필요(정적 코드 분석만으론 100% 확답 불가) —
  값이 비어있으면 그냥 `folder: null`로 보내고 UI에서 "알 수 없음" 처리.
- 매 30초 `${location.origin}/manager/api/sessions/heartbeat`로 POST
  (`MANAGER_URL` 패턴은 `tailscale-notify.default.js`/
  `webmanager-launcher.default.js`와 동일하게 `${location.origin}/manager/`
  사용 — 같은 origin이라 CORS 불필요, `config/nginx.default.conf`가 `/manager/`
  를 webmanager로 프록시).
- body: `{ id, folder, userAgent: navigator.userAgent }`. IP는 전송 안 함.
- `try { await fetch(...) } catch { return }` — 실패(네트워크 에러, 404 등
  = webmanager 없음/구버전)는 완전히 조용히 무시. 배너/토스트 없음(이 기능은
  code-server 쪽에 아무 UI도 없음 — `tailscale-notify`와 달리 `CDDialog` 불필요).
- `config/code-patch.default.sh`는 `patch/*.default.*`를 자동 glob으로
  seed하므로 이 파일을 추가하는 것 외에 별도 등록 작업 불필요.

### 백엔드

새 패키지 `webmanager/backend/internal/sessionheartbeat/`, 아래 두 기존 구현을
그대로 본떠서:

- 스토어 모양은 `internal/authgate/session.go`의 `sessionStore`
  (`sync.Mutex` + `map[string]T`) 패턴.
- GC 루프는 `internal/termsession/registry.go`의 `Registry.Run(ctx)`
  (`time.NewTicker(gcInterval)` + 주기적 reap) 패턴 그대로.

```go
type entry struct {
    Folder    string
    UserAgent string
    LastSeen  time.Time
}

type Store struct {
    mu      sync.Mutex
    entries map[string]entry // key: client-generated session id
}
```

- `listWindow = 5 * time.Minute` — 목록 조회 시 이 안에 heartbeat 없으면
  제외 (사용자가 "1~10분" 범위를 줬으므로 중간값으로 잠정 결정 — 정확한 값은
  실사용 피드백으로 조정, env로 빼지 않고 상수로 시작. 근거: 이 정도 튜닝값을
  미리 env화하는 건 과설계 — 필요해지면 그때 뺀다).
- `gcInterval = 15 * time.Minute`, `gcIdleAfter = 30 * time.Minute` (heartbeat
  없이 이만큼 지난 항목은 목록 필터와 별개로 맵에서 완전히 제거 — 메모리
  상한 목적. 사용자가 준 "10~30분" 범위의 상한값 사용).
- `Heartbeat(id, folder, userAgent string)` — upsert.
- `List() []entry` — `listWindow` 안의 것만, `LastSeen` 내림차순.
- `Run(ctx)` — termsession과 동일한 ticker 루프, `gcIdleAfter` 지난 항목
  삭제.

라우트 (`main.go`, 기존 등록 스타일 그대로):

```go
mux.HandleFunc("POST /api/sessions/heartbeat", s.handleSessionHeartbeat) // 절대 gate 걸지 말 것 — code-server 쪽은 인증 수단이 없음
mux.Handle("GET /api/sessions", gate.RequirePassword(http.HandlerFunc(s.handleListSessions)))
```

`main.go`의 `bgCtx`/`go s.termSessions.Run(bgCtx)` 바로 옆에
`go s.sessionHeartbeats.Run(bgCtx)` 추가 (약 main.go:321 근처).

heartbeat 요청 바디는 크기 제한(예: 4KB) + `id`가 UUID 형식인지 정도만
검증 — `userAgent`/`folder`는 자유 문자열이라 파일 경로/커맨드로 흘러들어가는
게 아니므로 이스케이프 불필요(단, 프론트에서 렌더링할 때 React가 기본
이스케이프하므로 XSS 걱정 없음 — `dangerouslySetInnerHTML` 쓰지 말 것).

### 프론트엔드

- 새 사이드바 탭(가칭 "열린 세션" 또는 기존 탭 하위 섹션 — 판단은 구현
  에이전트가 UX 보고 결정) — `List()` 결과를 폴더/브라우저(UA 요약)/마지막
  활동(상대 시간) 테이블로.
- 게이트된 엔드포인트이므로 `<RequiresUnlock>`로 감싸기(Terminal/Files와
  동일 패턴).
- 30초 폴링(heartbeat 주기와 맞춤), 첫 로드는 `Skeleton` 컴포넌트, `setLoading(false)`는
  `withViewTransition`으로 감싸기 — "First-load skeleton" 컨벤션(`webmanager/CLAUDE.md`) 그대로 따를 것.
- User-Agent 원문은 길고 읽기 어려우므로 브라우저/OS 정도만 뽑아 요약 표시
  (간단한 정규식 파싱이면 충분, 라이브러리 추가 불필요 — 실패하면 원문 그대로
  fallback).

## 구현 체크리스트

1. `webmanager/backend/internal/sessionheartbeat/` (store + Run + 타입)
2. `main.go`: 라우트 2개 등록 + `go ...Run(bgCtx)` 추가
3. `config/code-patch/session-heartbeat.default.js`
4. 프론트엔드 탭/섹션 + `api/client.ts`에 엔드포인트 함수 추가
5. `go build`/`go vet` (backend), `npm run build`/lint (frontend) 검증
6. `webmanager/CLAUDE.md` "이미 구현됨" 절에 반영, `webmanager/.claude/README.md`
   인덱스에서 이 문서를 `qa-request/`로 옮기고 표에 추가 (사용자 실컨테이너
   검증 전까지)
7. `webmanager/.claude/research/session-viewer-plan.md` 상단에 "이 방식으로
   대체/착수됨, 본 문서는 옵션 2(코드서버 자체 연결 API)가 여전히 미조사
   상태라는 기록으로만 남김" 메모 추가

## 열린 질문 (경미, 구현 막지 않음 — `question.md`에도 등록)

- `folder` 쿼리스트링이 워크벤치 부팅 후에도 `location.search`에 남아있는지
  실컨테이너에서 확인 필요. 없어지는 걸로 확인되면 대안(예: `document.title`
  파싱)을 다시 설계해야 함.
- `listWindow`/`gcIdleAfter` 정확한 값은 잠정치 — 실사용 피드백 받으면 조정.
