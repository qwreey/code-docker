# Claude Code 상태/관리 패널 조사 (M1+M2+M3 구현 완료, M4부터 미착수)

## 구현 완료 (2026-08-02): M3

`internal/claudecode`에 `ListPlugins`(`claude plugin list --json` 래핑, 실패 시
빈 배열로 열화) 추가, `GET /api/claude/plugins` 신규. 프론트는 기존
`InstalledView`에 `PluginsTable` 카드 추가(이름/버전/scope/활성 여부, id를 `@`로
split해서 마켓플레이스 서픽스는 서브텍스트로). `go build`/`go vet`/`gofmt`,
`npm run build`/`npm run lint` 전부 클린.

> `caddy-plan.md`/`.claude/archive/tailscale-design.md`(레포 루트)와 같은 성격으로
> 시작한 문서였으나, 이제 마일스톤까지 정리돼서 **M1은 바로 구현 착수 가능한 상태**.
> 저장소 일반 컨벤션은 루트 `CLAUDE.md`, webmanager 컨벤션은 `webmanager/CLAUDE.md`,
> `webmanager/plan.md` 참고.

## 구현 완료 (2026-08-02): M1 + M2

**M1**: `internal/claudecode`(바이너리 탐지, `CLAUDE_CONFIG_DIR` 존중, 5초
타임아웃) + `handlers_claude.go`의 `GET /api/claude/status`. 프론트
`src/components/ClaudeCode/ClaudeCode.tsx` — 미설치 시 유령/스켈레톤 오버레이,
설치 시 로그인 상태/총 사용량/오늘·이번 주/최장 세션 카드.

**M2**: `internal/claudecode`의 `Stats`에 `dailyActivity`/`dailyModelTokens`/
`hourCounts`/`modelUsage` 추가(같은 `stats-cache.json`을 확장 파싱, 새 라우트
불필요 — 기존 `GET /api/claude/status` 응답만 확장). 프론트에 `dataviz` 스킬을
따라 `Heatmap.tsx`(월간 뷰, `messageCount` 단일 지표, 5단계 sequential 버킷),
`WeeklyChart.tsx`(최근 7일 message/toolCall 그룹 바 차트), `ModelUsageChart.tsx`
(모델별 input/output/cache-read 토큰, 크기 차이가 커서 단일 축 대신 패널 분리)
추가 — 외부 차트 라이브러리 없이 SVG/CSS로 직접 구현. `go build`/`go vet`/`gofmt`,
`npm run build`/`npm run lint` 전부 클린 확인.

## 구현 마일스톤

기능을 한 번에 다 만들지 않고 단계적으로 진행 — M1/M2 완료, 다음은 M3.

- ~~**M1**~~: 완료 (위 참고).
- ~~**M2**~~: 완료 (위 참고).
- **M3**: Skills/Plugins 목록 조회(`claude plugin list --json`, 조회 전용).
- **M4**: 확장 설치 배너 — `extensions-plan.md`의 API(있다면)를 재사용, 없으면 이
  기능 자체에서 최소하게 구현. webmanager 설정 저장소(`/code/.webmanager/
  config.yaml`, 아래 참고) 필요해지는 첫 지점.
- **M5 (기술적으로 까다로워서 뒤로 미룸)**: MCP 서버 목록. `claude mcp list`가
  `--json`을 지원하지 않아 텍스트 파싱이 필요하고, 실제 서버가 여러 개 등록된
  출력을 아직 못 봐서 파싱 규칙을 지금 확정할 수 없음 — 실제 MCP 서버를 등록해보고
  출력을 관찰한 뒤에 설계할 것.
- **로그인(OAuth) 자동화**: 이 마일스톤 목록에 없음 — 사용자가 직접 터미널에서
  진행하기로 확정(아래 "로그인(OAuth) 연계" 절은 참고 조사 자료로만 유지, 구현
  안 함).

**M1 기준 다른 미해결 사항 없음** — "미해결 질문" 절에 남아있던 항목은 전부 M5(MCP
파싱) 아니면 로그인(사용자 직접 진행) 관련이라, M1 구현을 막는 열린 질문은 없음.

## M1 API 계약 (확정, 구현 착수)

새 패키지 `internal/claudecode` (기존 `internal/tailscale` 등과 동일하게 `exec.Command`
래핑 패턴), 새 핸들러 파일 `handlers_claude.go`.

- **바이너리 탐지**: `WEBMANAGER_CLAUDE_BINPATH` 환경변수(기본값 없음) 우선, 없으면
  PATH에서 `claude` 조회. 둘 다 실패하면 "미설치" 취급 — 에러 아님.
- **설정 디렉토리**: `CLAUDE_CONFIG_DIR` 환경변수를 존중(설정돼 있으면 그 경로),
  기본값은 `$HOME/.claude`(= `/code/.claude`, `HOME`이 `/code`로 고정되어 있으므로).
  `stats-cache.json`은 이 디렉토리 밑.
- **타임아웃**: `claude auth status` 등 서브커맨드 호출에 `context.WithTimeout`
  5초 정도 — 네트워크 헬스체크가 섞여있을 수 있어 응답이 느려도 webmanager 전체가
  멈추면 안 됨(claude-plan.md 본문의 MCP 관련 경고와 동일한 이유, 여기도 미리 적용).

### `GET /api/claude/status`

```json
{
  "installed": true,
  "auth": {
    "loggedIn": true,
    "email": "user@example.com",
    "subscriptionType": "max",
    "authMethod": "claude.ai"
  },
  "stats": {
    "totalSessions": 10,
    "totalMessages": 1101,
    "firstSessionDate": "2026-06-22T03:32:40.557Z",
    "longestSessionMessageCount": 552,
    "longestSessionDurationMs": 42711197,
    "today": { "sessionCount": 0, "messageCount": 0 },
    "week": { "sessionCount": 0, "messageCount": 0 }
  }
}
```

- `installed: false`일 때는 `auth`/`stats` 필드 자체를 생략(또는 `null`) — 프론트는
  이 경우 유령/스켈레톤 + 설치 안내 오버레이만 표시.
- `installed: true`인데 `claude auth status --json` 호출이 실패/타임아웃되면
  `auth: null`로 열화(에러 아님) — `stats`는 `auth`와 독립적으로 채움(로그아웃 상태
  에서도 과거 통계는 파일에 남아있을 수 있음).
- `stats-cache.json`이 없거나 파싱 실패하면 `stats: null`로 열화.
- `today`/`week`는 `dailyActivity` 배열에서 오늘 날짜 항목 찾기 / 최근 7개 항목
  합산으로 계산 (UTC 기준 날짜 문자열 비교 — `internal/logstore`가 이미 UTC로
  통일한 것과 같은 이유로 일관되게 UTC 사용).
- 이 엔드포인트 자체가 실패하는 경우(위 열화 케이스 전부와 무관하게 정말 뭔가
  터진 경우)만 5xx — 나머지는 전부 200 + 필드별 null/false로 표현.

### 프론트

`src/components/ClaudeCode/ClaudeCode.tsx` — `sections.ts`에 `'claude'` 추가,
**다른 미구현 섹션과 달리 항상 실제 컴포넌트가 마운트됨**(`Placeholder` 패턴 아님).
`installed: false`면 유령/스켈레톤 배경 위에 "Claude Code가 설치되어 있지 않습니다 —
`mise use -g claude-code`로 설치하거나, 이미 설치되어 있다면
`WEBMANAGER_CLAUDE_BINPATH`를 설정하세요" 오버레이. `installed: true`면 카드로:
로그인 상태(이메일/구독 종류, `loggedIn: false`면 "터미널에서 `claude` 실행 후
로그인하세요" 안내만, 로그인 버튼 없음), 총 세션/메시지 수, 오늘/이번 주 세션·메시지
수, longest session(메시지 수 + 기간을 사람이 읽기 좋은 형태로 — 예: "42분").
그래프/히트맵 없음(M2에서).

## 목적

code-docker에 `claude`(Claude Code CLI, 보통 `mise use -g claude-code`로 설치)가 있으면
webmanager에 전용 탭을 띄워서:

1. 로그인 상태 + 사용 통계(세션/주간/월간 히트맵 등) 퀵 오버뷰
2. 설치된 스킬/플러그인, MCP 서버 조회
3. VS Code(code-server)용 Claude Code 확장 설치를 돕는 배너

를 제공한다. `claude`가 없는 환경(claude를 안 쓰는 인스턴스)에서는 최대한 조용히
빠져야 한다.

**구현 우선순위**: 로그인은 민감한 영역(인증 플로우, 크리덴셜)이라 **최후순위**로
미룸 — 사용자가 직접 실험/디버깅하며 진행하기로 함. 지금 구현 범위는 **이미
로그인된 상태를 전제로 한 조회 기능**(통계/스킬/MCP/확장 배너)만. 로그인 자체를
webmanager에서 실행하는 UI/서브프로세스 연동은 만들지 않는다 — 아래 "로그인(OAuth)
연계" 절은 조사 결과만 기록해두는 용도(나중에 사용자가 직접 진행할 때 참고 자료).

## 확정된 방향 (논의 후)

- **감지 + 미설치 상태 표시**: `claude` 바이너리가 PATH(또는
  `WEBMANAGER_CLAUDE_BINPATH` 오버라이드, 아래 참고)에 없어도 Claude 탭 자체는 항상
  보인다. 안은 내용 없는 "유령" 상태(스켈레톤/흐릿한 배경)만 깔고, 그 위에 "Claude
  Code가 설치되어 있지 않습니다 — `mise use -g claude-code`로 설치하거나, 이미
  설치되어 있다면 `WEBMANAGER_CLAUDE_BINPATH`를 설정하세요" 같은 오버레이 안내를
  띄운다. 다른 플랫폼(pve 등)에서도 흔한 패턴이라 이 쪽으로 일관되게 감.
- **사용 통계**: `~/.claude/stats-cache.json`을 그대로 읽는다. 실제로 열어보니
  일별/세션별/모델별 토큰/시간대별 데이터가 이미 다 집계되어 있어서(아래 참고) 원본
  세션 트랜스크립트(`~/.claude/projects/*/*.jsonl`)까지 파싱할 필요가 없음 — 그쪽은
  내부 포맷이라 버전마다 깨질 위험이 있어 일부러 안 건드림.
- **스킬/MCP**: 이번 라운드는 **조회 전용**. 추가/삭제는 나중 마일스톤으로 미룸(사용자
  결정). 설정 파일을 직접 파싱하지 않고 `claude` CLI 서브커맨드를 그대로 래핑 — CLI가
  이미 승인 대기(pending approval) 상태, 헬스체크 등 로직을 갖고 있어서 파일을 다시
  해석하는 것보다 안전함.
- **확장 설치**: `webmanager/ideas.md`에 후순위로 보류돼 있던 "익스텐션 목록
  조회/설치/삭제" 항목을 이번에 승격하되, 범위는 좁게 — 범용 확장 관리자 UI를 새로
  만드는 게 아니라 **Claude 탭 안에서** "Claude Code 확장이 안 깔려 있습니다" 배너
  하나(설치/닫기)만 띄운다. 닫으면 다시 안 뜨게 webmanager 쪽에 영속 저장(아래 "설정
  저장소" 참고).
- **로그인(OAuth) 자동화 — 최후순위, 이번 스코프 아님**: 브라우저 콜백을 SSH
  포트포워딩으로 우회할 필요 자체가 없다는 걸 확인함 — `claude` CLI가 이미 "콜백을
  못 받으면 코드를 화면에 보여주고 터미널에 붙여넣게" 하는 폴백을 컨테이너/SSH
  환경을 염두에 두고 내장하고 있음. 이 조사 결과는 나중을 위해 남겨두되, webmanager에
  로그인 실행 UI를 실제로 만드는 건 이번 스코프에서 뺌 — **로그인은 사용자가 직접
  터미널에서 진행**. 지금 구현 범위는 이미 로그인된 상태를 전제로 한 조회
  기능뿐(아래 "로그인(OAuth) 연계" 절은 참고 자료로만 유지).

## 데이터 소스 조사 결과 (실제로 확인함)

### `~/.claude/stats-cache.json`

```json
{
  "version": 4,
  "lastComputedDate": "2026-08-01",
  "dailyActivity": [
    { "date": "2026-06-22", "messageCount": 143, "sessionCount": 5, "toolCallCount": 28 }
  ],
  "dailyModelTokens": [
    { "date": "2026-06-22", "tokensByModel": { "claude-opus-4-8": 103525 } }
  ],
  "modelUsage": {
    "claude-opus-4-8": { "inputTokens": 83063, "outputTokens": 537961, "cacheReadInputTokens": 44426514, "...": "..." }
  },
  "totalSessions": 10,
  "totalMessages": 1101,
  "longestSession": { "sessionId": "...", "duration": 42711197, "messageCount": 552, "timestamp": "..." },
  "firstSessionDate": "2026-06-22T03:32:40.557Z",
  "hourCounts": { "11": 2, "12": 5, "13": 1, "14": 2 },
  "totalSpeculationTimeSavedMs": 0
}
```

`dailyActivity`(일별 세션/메시지/툴콜 수) → 월간 히트맵, `dailyModelTokens`/`modelUsage`
→ 모델별 토큰 사용량, `hourCounts` → 시간대별 분포, `totalSessions`/`longestSession`/
`firstSessionDate` → 퀵 오버뷰 카드. 주간 통계는 `dailyActivity`에서 최근 7일을 슬라이스
하면 됨(별도 필드 없음). `costUSD`는 현재 관측한 값들이 전부 `0` — 신뢰 가능한 비용
필드인지는 구현 시 재확인.

### `claude` CLI 서브커맨드 (실행해서 확인함, `claude --help` 기준)

| 커맨드 | 용도 | 출력 |
|---|---|---|
| `claude auth status --json` | 로그인 여부/이메일/구독 종류 | `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"...","orgId":"...","orgName":"...","subscriptionType":"max"}` — 토큰/시크릿 없음, 그대로 노출해도 git config 수준의 민감도 |
| `claude auth login` / `logout` | 로그인/로그아웃 | 브라우저 OAuth 플로우, 콜백 실패 시 코드-붙여넣기로 자동 폴백 (아래 "로그인 연계" 절) |
| `claude plugin list --json` | 설치된 스킬/플러그인 | `[{"id":"rust-analyzer-lsp@claude-plugins-official","version":"1.0.0","scope":"user","enabled":true,"installPath":"...","installedAt":"...","lastUpdated":"..."}]` |
| `claude plugin list --available --json` | 마켓플레이스에서 설치 가능한 것까지 포함 | (조회 전용 범위라 이번엔 안 씀, 참고용) |
| `claude mcp list` | 등록된 MCP 서버 | **텍스트 전용, `--json` 옵션 없음.** 서버 0개 상태에서만 확인함(`No MCP servers configured...`) — 실제 서버가 있을 때 출력 포맷은 아직 못 봄 |
| `claude mcp get <name>` | MCP 서버 상세 | 텍스트 전용 |
| `claude setup-token` | 구독 계정용 1년짜리 장기 토큰 발급 (CI/스크립트용, 세션 저장 안 함) | 로그인 UI 용도로는 `auth login`보다 우선순위 낮음 — 아래 "로그인 연계" 절 참고 |

`claude mcp`/`claude plugin`은 각각 add/remove/enable/disable도 있어서, 나중에 CRUD로
확장할 때도 파일을 직접 쓰지 않고 CLI를 그대로 래핑하면 됨(같은 이유).

## 로그인(OAuth) 연계 — 조사 결과 (참고용, 이번 스코프에서 구현 안 함)

> 이 절은 **최후순위로 미룬** 로그인 자동화를 나중에 사용자가 직접 진행할 때 참고할
> 조사 기록. 지금 구현 범위(퀵 오버뷰/통계/스킬/MCP/확장 배너)는 전부 이미 로그인된
> 상태를 전제로 하고, 여기 적힌 서브프로세스/pty/URL 파싱 설계는 아무것도 만들지
> 않는다.

공식 문서(`code.claude.com/docs/en/authentication`)에서 정확히 이 시나리오를 다루는
문구를 찾음:

> If your browser shows a login code instead of redirecting back after you sign in,
> paste it into the terminal at the `Paste code here if prompted` prompt. **This
> happens when the browser can't reach Claude Code's local callback server, which is
> common in WSL2, SSH sessions, and containers.**

즉 `claude auth login`(내부적으로 `/login`과 동일한 플로우)은 이미 "컨테이너 안이라
브라우저가 로컬 콜백 서버에 못 닿는 상황"을 전제로 설계돼 있음 — 리다이렉트가
실패하면 로그인 페이지 자체가 코드를 화면에 띄우고, 그 코드를 CLI 쪽 프롬프트에
붙여넣으면 로그인이 끝남. **SSH -L 포트포워딩이 필요 없다.** 사용자가 원래 가정했던
"콜백 포트를 SSH로 끌어와야 한다"는 전제 자체가 최신 CLI에서는 불필요한 것으로 보임 —
그냥 URL 열고, 안 되면 뜨는 코드를 붙여넣으면 끝.

이걸 그대로 웹 UI로 감쌀 수 있음:

1. webmanager 백엔드가 `claude auth login`을 서브프로세스로 띄우고 stdout을 실시간으로
   읽어 로그인 URL을 파싱(정규식으로 `https://...` 추출)
2. 프론트가 그 URL을 클릭 가능한 링크로 보여줌(사용자가 자기 브라우저로 염 — 그
   브라우저가 `localhost:PORT`로 리다이렉트를 시도하다 실패하면 로그인 페이지가 코드를
   보여줌)
3. 프론트에 코드 입력창 하나 — 사용자가 그 코드를 붙여넣으면 백엔드가 대기 중인
   서브프로세스의 stdin에 그대로 전달
4. 로그인 완료되면 `claude`가 알아서 `~/.claude/.credentials.json`에 세션을 저장

`$HOME`이 `user-init.default.sh`에서 이미 `/code`로 고정돼 있어서(`export
HOME="/code"`) `~/.claude/.credentials.json` 경로가 곧 `/code/.claude/.credentials.json`
— 이미 영속 볼륨(`./code:/code`) 안에 있음. 로그인 결과를 webmanager가 별도로 어딘가에
복사/보관할 필요가 없다 (컨테이너 재생성해도 그대로 남음).

`claude setup-token`도 같은 "브라우저 인가 플로우"를 타지만(문서: "The command opens
the same browser authorization flow as `/login`"), 발급한 토큰을 CLI가 저장하지 않고
화면에 한 번만 찍어줌 — 그걸 `CLAUDE_CODE_OAUTH_TOKEN` 환경변수로 어딘가에 직접
배포해야 함(CI 환경을 염두에 둔 설계). code-docker는 `$HOME`이 이미 공유/영속이라 이
추가 배포 단계가 오히려 불필요한 복잡도라, **로그인 UI는 `claude auth login`(=`/login`
과 동일 계열)을 감싸는 쪽으로 우선 진행**. `setup-token`은 "구독 없이 API 키만 쓰는
경우"처럼 다른 상황을 위해 백로그에 남겨두는 정도로 충분해 보임.

### VS Code 확장

open-vsx 레지스트리(`https://open-vsx.org/api/anthropic/claude-code`)에 공식
`anthropic.claude-code` ("Claude Code for VS Code") 확장이 실제로 게시돼 있음을 확인함
(다운로드 3600만+, 버전 2.1.220 — 로컬에 깔린 CLI 버전과 우연히 동일). 설치는 기존
`bin/code`가 하듯 `code-server --install-extension anthropic.claude-code`, 설치 여부
확인은 `code-server --list-extensions`로 하면 됨.

## 웹매니저 UI 설계 (스케치)

- `sections.ts`에 `'claude'` SectionId 추가. 다른 미구현 섹션(`mise`, `dind`, `terminal`)
  과 달리 `implemented: false` placeholder가 아니라 **항상 실제 컴포넌트가 뜨되, 내부
  상태로 "설치 안 됨"을 표현** — 유령/스켈레톤 배경 위에 설치 안내 오버레이(위 "감지 +
  미설치 상태 표시" 참고).
- 탭 내부 카드 구성:
  - **퀵 오버뷰**: 로그인 상태(이메일/구독 종류), 총 세션 수, 오늘/이번 주 세션·메시지
    수, longest session. 로그인 안 된 상태면 `claude auth status`가 `loggedIn: false`를
    반환할 텐데, 이번 스코프에선 그 사실만 표시(예: "터미널에서 `claude` 실행 후
    로그인하세요") — 로그인을 실행하는 버튼/UI는 만들지 않음(위 우선순위 참고)
  - **히트맵**: `dailyActivity` 기반 GitHub contribution graph 스타일 월간 뷰
  - **주간 그래프**: 최근 7일 messageCount/toolCallCount
  - **모델별 토큰 사용량**: `dailyModelTokens`/`modelUsage` 기반
  - **Skills/Plugins**: `claude plugin list --json` 결과 테이블(이름/버전/scope/활성 여부)
  - **MCP 서버**: `claude mcp list` 파싱 결과 — 정확한 파싱 규칙은 실제 서버가 등록된
    출력을 본 뒤 다시 잡아야 함(위 표 참고)
  - 위 그래프류는 반드시 `dataviz` 스킬 가이드(색/형태/접근성)를 따라 구현
- **확장 추천 배너**: Claude 탭 안, `code-server --list-extensions`로
  `anthropic.claude-code` 미설치 확인 시 노출, "설치"/"닫기". 닫으면 webmanager 설정
  저장소(아래)에 dismissed 플래그를 기록해서 다시 안 뜨게 함.

## webmanager 설정 저장소 (신설 필요)

지금까지 webmanager 기능들은 전부 각자의 대상 파일(`~/.gitconfig`,
`/code/.tailscale/config.yaml` 등)을 직접 읽고 썼지, "webmanager 자신의" 설정을 담는
곳은 없었음(코드 전수 확인함). 확장 배너 dismissed 여부 같은 게 처음으로 그런 저장소가
필요한 사례라, `/code/.webmanager/config.yaml` 하나를 새로 만드는 게 나아 보임 —
빈도가 낮고 사람이 직접 열어볼 수도 있는 값들이라 sqlite보다 yaml이 기존
`tailscale/config.yaml` 패턴과도 맞음(같은 `gopkg.in/yaml.v3` 의존성 재사용, 신규
의존성 불필요). 스키마 예시:

```yaml
claude:
  extensionBannerDismissed: false
```

나중에 다른 기능이 webmanager 자체 설정이 필요해지면 같은 파일에 최상위 키만
추가하면 됨.

## 백엔드 설계 스케치

- `internal/claudecode` 패키지 신설, 기존 `internal/tailscale`처럼 `exec.Command`로
  `claude` CLI를 래핑하는 패턴 재사용.
- **바이너리 경로**: PATH에서 `claude` 조회, 없으면 `WEBMANAGER_CLAUDE_BINPATH`(신규
  env, 기본값 없음 — 설정 안 하면 그냥 PATH 조회 실패로 "미설치" 취급) 확인. 공식
  `CLAUDE_CONFIG_DIR` 환경변수(문서에서 확인함 — `~/.claude` 위치를 바꾸는 Claude Code
  자체 표준 변수)가 설정돼 있으면 그것도 그대로 존중, webmanager가 별도의
  `WEBMANAGER_CLAUDE_CONFIGPATH` 같은 걸 새로 만들 필요는 없음.
- **`$HOME`/단일 유저 전제**: code-docker는 컨테이너 안에서 root 하나만 쓰는
  설계이고(`user-init.default.sh`가 `export HOME="/code"`로 고정) webmanager와
  code-server 둘 다 같은 `$HOME`을 본다 — PATH만 프로그램별로 다를 수 있음(mise
  shim이 supervisord 프로그램 환경에 없을 수 있음). `WEBMANAGER_CLAUDE_BINPATH`
  오버라이드가 이 문제의 탈출구 역할도 겸함.
- (로그인 서브프로세스/pty 관련 설계는 최후순위 항목이라 위 "로그인(OAuth) 연계"
  절로 옮김 — 지금 스코프에선 안 만듦)
- `claude mcp` 등 네트워크 헬스체크가 섞인 서브커맨드는 타임아웃을 반드시 걸 것(느린
  MCP 서버 하나 때문에 웹매니저 응답이 멈추면 안 됨).

## README에 반영 필요 (사용자가 직접 작성 예정 — 자리만 남김)

- `mise use -g claude-code` 설치 안내 (mise 레지스트리에 `claude`/`claude-code` 별칭 둘
  다 등록되어 있고 `aqua:anthropics/claude-code` 백엔드로 실제 설치됨을 확인함).
- **로그인**: 원래 가정했던 "SSH -L로 콜백 포트를 끌어와야 한다"는 전제가 최신 CLI
  에서는 불필요해 보임(위 "로그인 연계" 절 참고) — `claude`/`claude auth login`을
  터미널에서 그냥 실행하고, 브라우저가 리다이렉트를 못 받으면 로그인 페이지가 보여주는
  코드를 터미널에 붙여넣으면 끝. webmanager를 안 쓰고 code-server 통합 터미널이나 순수
  SSH 세션에서 로그인하는 사람들을 위한 문구가 필요하면 이 사실 위주로 적으면 될 것
  같음. **실제 설명 문구는 사용자가 작성.**

## 미해결 질문 (M5로 미룸 — M1~M4 구현을 막지 않음)

1. `claude mcp list`가 `--json`을 지원하지 않음(`plugin list`와 비대칭). 텍스트를
   파싱할지, 아니면 `~/.claude.json`/`.mcp.json` 설정 파일을 직접 읽는 쪽이 나을지 —
   실제 서버가 여러 개 등록된 출력을 본 뒤 재검토. **M5(MCP) 착수 시점에 결정, 지금
   아님.**

## 미해결 질문 — 로그인(마일스톤에 없음, 사용자가 직접 진행할 때 참고용으로만 유지)

2. `claude auth login` 서브프로세스를 파이프로만 다뤄도 URL/코드 프롬프트가 정상
   노출되는지, 아니면 pty가 꼭 필요한지.
3. 로그인 URL을 stdout에서 정규식으로 뽑아내는 게 버전에 안전한지 — `claude` 업데이트로
   출력 문구가 바뀌면 파싱이 깨질 수 있음. `--output-format=json`류로 안정적으로 뽑을
   방법이 있는지(현재 확인된 바로는 `auth login`엔 그런 옵션 없음) 재확인 필요.
4. 로그인 중 사용자가 중간에 webmanager 탭을 닫거나 새로고침하면 대기 중이던
   서브프로세스를 어떻게 정리할지(타임아웃, 세션 재개 등) — 설계 필요.

## 참고

- `webmanager/plan.md`, `webmanager/CLAUDE.md`, `webmanager/ideas.md`
- `webmanager/frontend/src/components/Layout/sections.ts`
- open-vsx 확장: `https://open-vsx.org/api/anthropic/claude-code`
