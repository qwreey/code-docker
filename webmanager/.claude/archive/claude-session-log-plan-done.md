# Claude 대화 로그 뷰어 (2026-08-04 v1 구현 완료, agent-fleet-audit-plan.md 후속)

## 구현 완료 (2026-08-04)

아래 설계 그대로 구현. 실제 로컬 `~/.claude/projects`(29개 세션, 여러
프로젝트, 최대 ~1MB 파일)를 대상으로 `ListSessions`/`ReadSessionLines`를
수동 검증 — preview 추출, cursor 페이지네이션(`hasMore`), path traversal
거부(`../../../etc/passwd` 등) 전부 정상 동작 확인 후 검증용 테스트 파일은
삭제(레포에 자동화 테스트 관행이 없음 — `internal/envmigrate`가 유일한
예외). 벤더링 도중 실제 데이터에서 발견한 이슈 하나 수정: `/clear` 같은
슬래시 커맨드는 `<local-command-caveat>` 래퍼만 `isMeta:true`이고
`<command-name>...`/`<local-command-stdout>...` 본문 엔트리 자체는
`isMeta`가 없어서 그대로 두면 preview/채팅뷰에 노이즈로 샘 — 백엔드
`isSlashCommandArtifact`/프론트 `isNoiseUserEntry`로 별도 필터링 추가.

`gofmt`/`go build`/`go vet`, `npm run build`/`npm run lint` 전부 클린.
컨테이너 안에서의 실제 QA(비밀번호 게이트 동작, 실제 다른 세션 UI 확인)는
아직 안 함 — 레포 소유자 확인 필요.


루트 `.claude/backlog/agent-fleet-audit-plan.md`가 "이미 공짜로 영속화됨" 이라고
적어둔 세션 트랜스크립트(`CLAUDE_CONFIG_DIR/projects/*/*.jsonl`)를 webmanager
Claude 탭에서 직접 조회할 수 있게 한다. `webmanager/.claude/research/
session-viewer-plan.md`가 경고한 "세션" 다의성과는 무관 — 그건 브라우저/PTY
세션 얘기고, 이건 Claude Code 대화 세션(3번째 의미)을 명시적으로 다루는 기능.

## 사용자와 확정한 결정 (2026-08-04)

1. **세션 목록 범위**: `CLAUDE_CONFIG_DIR/projects/*` 전체 프로젝트 (현재 `/code`
   워킹트리 하나로 제한하지 않음).
2. **렌더링**: 사람이 읽기 좋은 축약 채팅뷰 (원본 JSON 그대로 보여주는 방식 아님).
3. **게이팅**: 다른 읽기 전용 기능과 다르게, 이 기능은 **조회부터 비밀번호 요구**
   (Terminal/File Manager/Logs와 동급 신뢰 등급) — 사용자 명시 요청.
4. **파싱 전략**: 직접 파서를 새로 짜지 않고, 실제 조사해서 찾은
   [`d-kimuson/claude-code-viewer`](https://github.com/d-kimuson/claude-code-viewer)
   (MIT, ⭐1267, 2026-08-03 최신 커밋)의 `src/lib/conversation-schema/`
   Zod 스키마 폴더를 벤더링해서 재사용. 이 폴더는 자기들 서버/UI 코드와
   분리된 순수 스키마 모듈(zod에만 의존)이라 벤더링하기 적합함 — 단, 이
   프로젝트가 스키마만 따로 npm 패키지로 배포하진 않으므로 "의존성 업데이트로
   자동 반영"은 아니고, 필요할 때 해당 폴더를 다시 복사해오는 수동 sync.
   조사 과정에서 확인한 다른 후보들(Python 변환 도구, 독립 뷰어 앱들)은 전부
   API가 아니라 완결된 앱이라 재사용 부적합.

## 아키텍처

**백엔드는 JSONL 스키마를 모른다** — 목록(가벼운 메타데이터)과 원본 라인
페이지네이션만 제공. 파싱/렌더링은 전부 프론트(벤더링한 Zod 스키마)에서 처리.
Logs 탭의 "부분 실패는 라인 단위로 열화" 컨벤션을 그대로 따름 — 스키마에 안
맞는 라인은 개별적으로 건너뛰고 전체 요청을 실패시키지 않는다.

### 백엔드 (`internal/claudecode/sessions.go`, 신규)

- `ListSessions(configDir string) ([]SessionInfo, error)` — `<configDir>/
  projects/*/*.jsonl` (최상위 파일만, `subagents/`/`tool-results/` 같은
  하위 디렉터리는 이번 스코프에서 무시 — 아래 "스코프 밖" 참고) 스캔. 각
  세션은 파일 stat(mtime/size) + 앞부분 몇 줄만 읽어 얻는 preview 텍스트
  (첫 non-meta user 메시지 스니펫)만 포함 — 메시지 수를 세려고 전체 파일을
  읽지 않음(관측된 트랜스크립트가 10MB에 달함).
- `ReadSessionLines(configDir, project, sessionId string, cursor, limit int)
  (lines []string, hasMore bool, err error)` — 원본 라인을 그대로
  `[cursor, cursor+limit)` 반환 (파싱 안 함). `hasMore`는 `limit+1`개를
  읽어보고 판단(전체 스캔으로 total count 세지 않음).
- **경로 검증**: `project`/`sessionId` 둘 다 `/`, `\`, `..`를 거부하는
  엄격한 검증 + `filepath.Join` 후 `filepath.Clean`이 여전히
  `<configDir>/projects` 밑에 있는지 재확인 (기존 "고정 식별자는 strict
  검증" 컨벤션 그대로, 방어 중복 허용).
- 새 핸들러 `handlers_claude.go`에 추가:
  - `GET /api/claude/sessions` — 목록, **`gate.RequirePassword`**
  - `GET /api/claude/sessions/{project}/{sessionId}?cursor=&limit=` — 라인
    페이지네이션, **`gate.RequirePassword`**

### 프론트

- `frontend/src/vendor/claude-conversation-schema/` — 위 kimuson 레포의
  `src/lib/conversation-schema/` 폴더를 그대로 복사, 최상단에 출처 URL +
  가져온 커밋/버전 + MIT 라이선스 고지 주석 추가. `package.json`에 `zod`
  의존성 신규 추가(벤더링된 코드가 요구하는 zod 4.x).
- `frontend/src/components/ClaudeCode/SessionLog/`:
  - `SessionList.tsx` — `GET /claude/sessions` 호출, 프로젝트별로 묶어서
    카드 목록(최근 수정 시각/크기/preview), 클릭 시 뷰어 오픈.
  - `SessionViewer.tsx` — 라인 커서 페이지네이션으로 로드, 각 라인을
    벤더링한 `ConversationSchema.safeParse`로 파싱 — 실패한 라인은
    조용히 스킵. **v1 렌더 범위**: `user`/`assistant` 엔트리만 채팅
    말풍선으로 표시(다른 엔트리 타입은 스킵). assistant의 `text`는 문단,
    `thinking`은 기본 접힘, `tool_use`는 "🔧 도구명(요약)" 한 줄 + 펼치기.
    다음 `user` 엔트리에 실려오는 `tool_result` 블록은 별도의 작은
    펼치기 카드로 표시(같은 turn의 tool_use와 자동 매칭/페어링은 이번
    스코프 밖 — `tool_use_id`만 참고용으로 노출).
- `ClaudeCode.tsx`의 설치됨 뷰 안에 새 카드 섹션 추가, 전체를
  `<RequiresUnlock>`로 감쌈(App.tsx 레벨이 아니라 컴포넌트 레벨 wrap —
  `RequiresUnlock`은 원래 특정 기능에 종속되지 않은 범용 컴포넌트라
  기존 컨벤션에 맞음).

## 스코프 밖 (v1에서 의도적으로 제외)

- **서브에이전트/사이드체인 트랜스크립트** (`<sessionId>/subagents/*.jsonl`)
  와 **외부로 스필오버된 tool-result 파일**(`<sessionId>/tool-results/*.txt`,
  큰 툴 출력이 본문 대신 참조로만 남는 경우) — 메인 트랜스크립트 렌더만
  우선 구현, 이 두 개는 조사는 됐으나 후속 마일스톤.
- **tool_use ↔ tool_result 자동 페어링** — 위 참고.
- `claude` CLI 미설치 상태에서도 과거 로그 열람 — 현재는 `installed` 상태일
  때만 이 섹션이 보임 (설치 여부와 무관하게 파일 유무로만 판단하는 게 더
  정확하지만, 흔한 케이스가 아니라 이번 스코프에서 단순화).

## 참고

- `.claude/backlog/agent-fleet-audit-plan.md` (레포 루트) — 이 기능의 동기가
  된 원 문서.
- `.claude/archive/claude-plan-done.md` — 기존 Claude 탭 설계, `stats-cache.json`만 쓰고
  원본 트랜스크립트는 "버전마다 깨질 위험" 때문에 일부러 안 건드리기로 했던
  결정 지점(이번 기능은 그 결정을 프론트엔드 벤더링 스키마로 우회해서 뒤집음).
- https://github.com/d-kimuson/claude-code-viewer — 벤더링 출처.
