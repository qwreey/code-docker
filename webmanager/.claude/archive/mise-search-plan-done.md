# mise 도구 검색 + 버전 선택 — 구현 완료

기존 mise 관리(`archive/mise-plan-done.md`, 구현 완료)는 **고정된 추천
목록**에서만 설치 가능하고, 버전은 항상 `'latest'`로 하드코딩돼 있음
(`Mise.tsx`의 `handleInstall`이 `version: 'latest'`를 그대로 보냄, 별도 버전
선택 UI 없음). 추천 목록에 없는 임의 도구를 찾아 설치하거나, 특정 버전을
골라 설치하는 경로가 아예 없다는 게 이번 요청의 갭 — 이 문서는 그 갭을 메우는
"도구 검색 + 버전 선택" 기능 설계.

## CLI 표면 (실측, 2026-08-05, mise 2026.7.15 기준)

- **`mise registry --json`** — 995개 엔트리, `[{short, backends[],
  description, aliases[]}]` 평면 배열. `archive/mise-plan-done.md`가 추천
  목록용으로 이미 실측한 것과 동일 커맨드 — 이번엔 자유 검색용으로 재사용.
- **`mise ls-remote <tool> --json`** — `[{version, created_at}]` 배열
  (node 기준 859개 엔트리). `created_at`은 오래된 버전일수록 부정확한
  placeholder 값(예: 여러 버전이 똑같이 `"2011-08-26T00:00:00.0Z"`)이 섞여
  있는 게 실측으로 확인됨 — UI에서 날짜를 사용자에게 그대로 보여주지 말 것,
  정렬 용도로만 쓸 것(배열 자체가 이미 버전 오름차순).
- 콜드 캐시 상태에서도 `mise ls-remote ruby --json`이 ~0.3초, 캐시 히트 시
  ~40ms — 네트워크 I/O가 섞여 있지만 느리지 않음. `mise.go`의 기존
  `readTimeout`(15초) 안에 여유 있게 들어옴 — 별도 job/스트리밍 인프라 없이
  `ListTools`/`GetEnv`와 같은 "동기 shell-out + JSON 파싱" 패턴을 그대로
  재사용 가능.

## 설계 방향

### 백엔드 (`internal/mise`, `handlers_mise.go`)

- 함수 2개 추가:
  - `SearchRegistry(ctx, binPath) ([]RegistryEntry, error)` — `mise registry
    --json` 그대로 파싱.
  - `ListRemoteVersions(ctx, binPath, toolID string) ([]RemoteVersion,
    error)` — `mise ls-remote <toolID> --json`. `toolID`는 기존
    `ValidateToolID`로 exec 전에 검증(다른 mise 함수들과 동일 패턴).
- `mise registry --json`은 사실상 정적인 데이터(요청마다 바뀌지 않음) —
  검색어를 입력할 때마다 매번 shell-out 하지 말고 **webmanager 프로세스
  내 인메모리 캐시**로 감싸고, 실제 문자열 매칭(`short`/`aliases`/
  `description` 부분 일치)은 Go 쪽에서 처리. 엔드포인트 예:
  `GET /api/mise/registry/search?q=<query>`.
- `mise ls-remote`는 도구별 실제 네트워크 조회라 registry보다 캐시 TTL을
  짧게 두거나(예: 10분), 0.3초 이하로 충분히 빠르니 아예 캐시 없이 매번
  호출해도 무방 — 착수 시 재판단. 엔드포인트 예:
  `GET /api/mise/versions?id=<toolID>`.
- 설치 자체는 새 엔드포인트 불필요 — 기존 `POST /api/mise/tools`가 이미
  `version`을 임의 문자열로 받도록 설계돼 있음(`handleCreateMiseTool`,
  현재 프론트만 `'latest'`를 하드코딩할 뿐). 프론트가 실제 선택된 버전을
  넘기기만 하면 기존 `mise.JobStore`/`JobPanel` 흐름 그대로 재사용.

### 프론트엔드 (`components/Mise/`)

사용자가 이번 요청에서 이미 방향을 제시함 — 그대로 반영:

- **다이얼로그**: "추천 도구 설치" 섹션 옆에 "도구 검색" 버튼 → 모달 오픈.
  검색 결과 목록 + 버전 목록까지 2단계라 레이아웃 변동이 커서, 기존
  `ConfirmDialog`류(단순 확인용)보다 큰 전용 컴포넌트가 필요
  (`Mise/ToolSearchDialog.tsx` 정도).
- **검색은 입력할 때마다가 아니라 명시적 트리거**로: 사용자가 이미
  "5초마다 입력이 달라졌으면 보여주기"와 "검색 버튼을 눌러야 보여주기"
  중 후자가 맞다고 결론냄 — 디바운스는 "사용자가 다 입력했는지"를
  시스템이 추측해야 해서 타이밍이 애매하지만, 버튼(또는 입력창에서 Enter)은
  명확하고 예측 가능함. 두 트리거(버튼 클릭, Enter)를 같은 핸들러로 묶으면
  자연스러움.
- **2단계 흐름**:
  1. 검색어 입력 + 검색 버튼(또는 Enter) → `GET
     /api/mise/registry/search?q=...` → 결과 리스트 렌더(도구 short id,
     description, backends 배지).
  2. 결과에서 도구 하나 선택 → 같은 다이얼로그 안에서 `GET
     /api/mise/versions?id=...` 호출 → 버전 리스트/선택 UI 렌더 → 버전
     선택 → 설치 버튼 → 기존 `POST /api/mise/tools`(`{id, version, global:
     true}`) + 기존 `JobPanel` 재사용.
- 검색 결과가 많을 수 있음(995개 중 흔한 검색어는 매치 다수) — 프론트에서
  표시 개수 제한(예: 상위 50개) + "더 있음, 검색어를 구체화하세요" 안내
  필요.
- 버전 목록도 도구에 따라 수백 개(node 859개) — 최신순으로 보여주되 기본은
  축약(예: 최근 20~30개 + "더 보기") 권장. 이 프로젝트가 UI 컴포넌트
  라이브러리 없이 직접 구현하는 관례상, 심플한 `<input>` 필터 + 스크롤
  리스트 정도가 적당해 보임(콤보박스 라이브러리 도입 불필요).

## 사용자 확인사항 → 최종 결정 (2026-08-05)

원래 열어뒀던 4개 질문, 사용자가 이번 요청에서 전부 직접 결정함:

1. **빈/짧은 쿼리**: 2글자 미만이면 API를 아예 호출하지 않고 "검색어는
   2글자 이상 입력하세요" 안내만 표시(프론트 사전 검증) — 2글자 유틸도
   존재하므로(`jq`, `gh`, `go`) 최소 길이를 1이 아닌 2로. 백엔드도
   `minRegistryQueryLen = 2`로 동일 기준을 재검증(안전망).
2. **registry 캐시**: 파일로 저장할 필요 없음, 인메모리 TTL로 충분 —
   `registryCacheTTL = 6h`(`internal/mise/mise.go`)로 구현. 버전 목록
   (`mise ls-remote`)은 캐시 없이 매번 실제 조회(0.3초 이하라 문제 없음).
3. **버전 목록 UI**: 콤보박스 아님, 스크롤 + 텍스트 필터(`ToolSearchDialog`의
   버전 단계) — 이미 설치된 버전은 설치 버튼 대신 "설치됨" 배지.
4. **설치 시작 후 다이얼로그**: 검색 다이얼로그를 닫고, 기존
   추천-설치/삭제/비활성화/재활성화와 동일한 **하나의 최상단(top-level)
   진행 다이얼로그**로 통합 — 개별로 인라인 렌더되던 기존 `JobPanel`을
   `Mise/JobDialog.tsx`(뷰포트 상단에 고정되는 모달 래퍼)로 감싸서 mise 탭의
   모든 job 트리거 액션이 같은 방식으로 뜨도록 통일. `ClaudeCode.tsx`의
   `JobPanel` 사용(자체 풀탭 오버레이, 직전 커밋에서 막 손본 것)은 건드리지
   않음 — 그쪽은 이미 자기 방식의 오버레이가 있어서 이중 오버레이가 될
   수 있음.

검색 결과 행에는 사용자 요청대로 **"버전 보기"**(해당 도구의 버전
스크롤+필터 뷰로 전환)와 **"설치"**(바로 `latest`로 원클릭 설치) 두 버튼을
둠.

## 구현 (백엔드)

- `internal/mise/mise.go`: `RegistryEntry`/`SearchRegistry`(TTL 캐시 +
  `short`/`description`/`aliases` 부분일치, 대소문자 무시) +
  `ListRemoteVersions`(`mise ls-remote <id> --json`, 캐시 없음, 기존
  `ValidateToolID`로 검증) 추가.
- `handlers_mise.go`: `GET /api/mise/registry/search?q=`(2글자 미만 400),
  `GET /api/mise/versions?id=` 핸들러 추가 — mise 미설치 시 다른 읽기
  핸들러들과 동일하게 빈 배열 200으로 성립(에러 아님). `main.go`에 두 라우트
  등록, 둘 다 읽기라 게이트 없음(기존 mise 읽기 엔드포인트들과 동일).
- 실제 로컬 `mise` 바이너리로 `SearchRegistry`("go" 검색 → `go` 엔트리
  확인)/`ListRemoteVersions`(`jq` 버전 목록 확인)/`ValidateToolID` 거부
  케이스까지 임시 테스트로 스모크 검증 완료(테스트 파일 자체는 커밋 안 함).

## 구현 (프론트엔드)

- `Mise/JobDialog.tsx`(신규): `JobPanel`을 뷰포트 상단 근처에 고정하는
  백드롭 모달로 감싸는 얇은 래퍼. 백드롭 클릭으로 닫히지 않음(진행 중인
  job을 실수로 안 보이게 하는 것 방지 — job 자체는 백엔드에서 계속 진행됨).
- `Mise/ToolSearchDialog.tsx`(신규): 검색 단계(입력+버튼/Enter → 결과
  리스트, 도구당 "버전 보기"/"설치" 버튼, 50개 초과 시 상위 50개만 + 안내)와
  버전 단계(뒤로가기, 필터 입력, 스크롤 리스트, 설치된 버전은 배지,
  300개 초과 시 상위 300개만 + 안내)를 하나의 다이얼로그 안에서 전환.
  설치 클릭 시 부모(`Mise.tsx`)의 `installTool` 콜백을 호출하고 스스로
  닫힘 — 곧바로 `JobDialog`가 뜨는 흐름.
- `Mise.tsx`: 기존 `handleInstall`을 범용 `installTool(id, version, label)`
  (`useCallback`)로 리팩터링, 추천 목록 설치는 그대로 `installTool(tool.id,
  'latest', ...)`를 호출하도록 축소. 헤더에 "도구 검색" 버튼 추가, 기존
  인라인 `<JobPanel>` 렌더를 `<JobDialog>`로 감쌈, `<ToolSearchDialog>`를
  다른 다이얼로그들과 나란히 렌더.
- `api/types.ts`: `MiseRegistryEntry`/`MiseRegistrySearchResponse`/
  `MiseVersionsResponse` 추가.

`go build`/`go vet`/`gofmt -l .`, `npm run build`/`npm run lint` 전부 클린.
**실컨테이너에서 사용자가 직접 확인 완료** — 정상 동작 확인됨.

## 참고

- `archive/mise-plan-done.md` — mise 관리 기능 전체 배경, 기존 CLI 표면
  조사 원본, API 설계.
- `frontend/src/components/Mise/Mise.tsx` — 설치 흐름 전체(`installTool`),
  `ClaudeCode.tsx`도 `JobPanel`을 공유하지만 `JobDialog`로는 감싸지 않음.
