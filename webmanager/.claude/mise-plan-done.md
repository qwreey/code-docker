# mise 관리 계획 — 구현 완료

## 구현 완료 (2026-08-02)

이 문서의 설계(리서치 → API 설계 → 백엔드/프론트 구현)대로 전부 구현 완료.
`internal/mise`(`FindBinary`/`WEBMANAGER_MISE_BINPATH`, 도구 id/버전 정규식 검증,
`ListTools`/`GetEnv`) + `internal/mise/jobs.go`(인메모리 `JobStore`, 완료된 잡
10분 지나면 정리 + 50개 상한) + `handlers_mise.go`(아래 API 설계 절 그대로:
`GET/POST/DELETE /api/mise/tools`, `GET /api/mise/env`, `GET /api/mise/jobs/:id`).
프론트 `src/components/Mise/` 신설(추천 도구 설치/설치된 도구 목록/env
미리보기/잡 진행상황 폴링), `ProjectTable.tsx`에 읽기 전용 "이 프로젝트가 쓰는
도구" 섹션 추가(사용자 확인 필요 절의 결정대로 v1은 읽기 전용). 4개 열린 질문은
`attention-needed.md`에 취합된 기본값(config에서도 제거는 기본 체크 해제, 폴링
스트리밍, `WEBMANAGER_MISE_BINPATH` 추가함)으로 처리.
`config/recommendations.default.yaml`에 `mise:` 키(카테고리별 추천 목록) 추가,
`RecommendationsResponse`에 `mise` 필드 노출까지 완료.

**실제 mise 바이너리로 라이브 스모크 테스트 완료**: 프로젝트 스코프 설치
(`jq@1.7.1`)/삭제(`removeFromConfig: true`로 `mise.toml`까지 실제로 비워짐)/잡
폴링/경로 검증(미등록 경로 400)/도구 id 검증(400)/존재하지 않는 잡 id(404) 전부
실제 동작 확인. **리서치 문서의 가정 하나 정정**: mise의 설치 진행 로그(`[1/2]
download` 등)는 stdout이 아니라 **stderr**로 나옴 — 구현은 이미 두 스트림을
합쳐서 받으므로 영향 없음, 기록만 남김.
`go build`/`go vet`/`gofmt`, `npm run build`/`npm run lint` 전부 클린.

## 업데이트 (2026-08-02, 두 번째 라운드) — UX 개선

- **카테고리 접기/펼치기**(기본 접힘 — 익스텐션 탭과 반대 방향으로 확정, 사용자가
  명시적으로 요청).
- **"추천 표시" 토글**(새로고침 버튼 옆), `localStorage`에 유지
  (`webmanager.mise.showRecommendations`) — 익스텐션 탭과 동일 패턴.
- **아직 안 함**(계획만): 각 도구에 "더 보기"(홈페이지/레지스트리) 링크 —
  `.claude/extension-search-plan.md`의 "1. 더 보기 정보 링크" 절 참고, mise
  쪽은 `mise registry --json`이 홈페이지 필드를 주는지부터 재확인 필요.

## Go/No-Go: GO — 최후순위 프레이밍 철회

`webmanager/CLAUDE.md`가 mise를 "범위가 넓어서 최후순위"로 미뤄뒀던 근거(버전
해석 로직을 자체 구현해야 할 것 같다는 우려, 스트리밍 출력을 위해 터미널 PTY
인프라가 먼저 필요할 것 같다는 우려)를 실제 `mise` CLI로 검증한 결과 **둘 다
사실이 아님**을 확인함:

- 버전 해석/설치/제거는 `mise use`/`mise install`/`mise uninstall`이 전부 알아서
  함 — 재구현할 로직이 없음. 익스텐션 기능(`internal/extensions`)과 완전히 같은
  모양의 "CLI shell-out + 결과 파싱"으로 끝남.
- `mise ls --json`/`mise env --json`/`mise registry --json` 전부 구조화된 JSON을
  내놓음 — `claude mcp list`(`claude-plan.md` M5가 뒤로 미뤄진 이유)처럼 텍스트
  파싱이 필요한 경우가 하나도 없음.
- 설치 진행 로그는 라인 버퍼링된 평범한 텍스트 스트림(`[1/3] download`, `[2/3]
  verify` 등)이라 실제 PTY가 필요 없음 — `terminal-plan.md`의 PTY/WebSocket
  인프라를 기다릴 이유가 없어짐(아래 "스트리밍 방식" 절 참고).
- 프롬프트/인터랙티브 셀렉터 위험도 낮음 — `mise`는 stdin이 닫혀있고 tty가 없는
  환경을 스스로 감지해서 (인자 없는 `mise use`처럼 원래 인터랙티브해야 하는
  케이스에서도) 멈추지 않고 바로 에러를 내고 종료함(직접 실행해서 확인함, 아래
  "CLI 표면 조사 결과" 참고).

난이도는 dind/웹쉘보다 낮고, 이미 완료된 익스텐션 관리 기능과 같은 급으로
재평가함. **결론: mise CRUD를 "최후순위"에서 빼서 익스텐션과 같은 "언제든 시작
가능" 티어로 승격 권장** — dind/웹쉘 완료를 기다릴 이유 없음, 특히 스트리밍
설계를 터미널 기능의 (아직 진행 중인) 설계에 종속시키지 말 것.

익스텐션(code-server) 추천/설치는 별도 문서(`extensions-plan-done.md`, 구현
완료)로 분리됨 — mise를 안 기다리고 더 일찍 만들어도 되는 독립적인 기능이라
우선순위도 다름.

## 배경

두 가지 원 요청:

1. mise로 설치할 만한 도구들을 카테고리별로 정리해서 "이런 거 설치하시겠어요?" 하는
   추천 UI
2. 기업에서 유저별로 컨테이너를 나눠주는 경우를 위해, 이 추천 목록을 배포하는 쪽이
   직접 추가/조정할 수 있게 override 가능한 설정 파일로 만들기

여기에 이번 라운드에서 사용자가 직접 mise CRUD 자체의 설계를 제안함(install/use/
uninstall CLI 래핑, 터미널 스트리밍 뷰, global+per-project 목록, 설치된 버전
목록, env 미리보기) — 아래 "CLI 표면 조사 결과"/"기능별 실현 가능성"/"API 설계"
절이 그 제안을 검증/구체화한 결과.

## 카테고리별 mise 도구 추천 목록 (초안)

**mise 짧은 이름/백엔드는 mise 버전에 따라 바뀔 수 있어서, 실제 구현 시점에
컨테이너 안에서 `mise registry`로 재확인 필요** — 아래는 2026-08 기준 조사 결과
(정확도 보장 안 됨). `mise registry --json`이 여전히 설계대로 동작함을 이번
라운드에 재확인함(`{short, backends[], description, aliases[]}` 배열, 아래 "CLI
표면 조사 결과" 참고) — 이 절 자체는 변경 없음.

### 언어 런타임/툴체인
- `node` — Node.js
- `deno` — Deno
- `bun` — Bun
- `go` — Go
- `rust` — Rust
- `zig` — Zig
- `java` — Java (버전 뒤에 벤더 지정 가능, 예 `java@temurin-21`)
- `haskell` — GHC/Haskell (mise core로 편입됐는지, asdf 플러그인 경유인지 재확인)

### CLI 유틸리티
- `gh` — GitHub CLI
- `fzf` — 퍼지 파인더
- `ripgrep`(`rg`) — grep 대체
- `fd` — find 대체
- `bat` — cat 대체(신택스 하이라이트, 백엔드가 여러 개일 수 있어 자동 선택되는지
  확인 필요)
- `jq` — JSON 처리
- `direnv` — 디렉토리별 환경변수
- `lazygit` — 터미널 git UI

### 확장 후보 (아직 요청 안 됐지만 자연스러운 카테고리)
- **인프라/클라우드 CLI**: `terraform`, `kubectl`, `helm`, `awscli` 등
- **패키지 매니저(언어별 보조)**: `pnpm`/`yarn` 등 — 별도 카테고리보다 해당 언어
  런타임 옆에 나열하는 편이 자연스러움

## `recommendations.default.yaml` 설계 (초안, mise 부분)

기존 override 패턴 그대로 — 단 이건 스크립트가 아니라 순수 데이터 파일이라 디스패처
자체는 필요 없고 webmanager 백엔드가 override 유무만 확인하고 읽으면 됨
(`code-config.*.yaml`이 이미 "디스패처 없는 데이터형 override"의 선례). 이
파일/`GET /api/recommendations`는 익스텐션 기능 구현 시 이미 실제로 만들어짐
(`extensions-plan-done.md` 참고) — mise 쪽 `mise:` 최상위 키만 아직 안 쓰임.

```yaml
mise:
  - category: "언어 런타임/툴체인"
    tools:
      - id: node
        label: Node.js
        description: JavaScript/TypeScript 런타임
      - id: go
        label: Go
      - id: rust
        label: Rust
      - id: deno
        label: Deno
      - id: bun
        label: Bun
      - id: zig
        label: Zig
      - id: java
        label: Java
      - id: haskell
        label: GHC (Haskell)
  - category: "CLI 유틸리티"
    tools:
      - id: gh
        label: GitHub CLI
      - id: fzf
        label: fzf
      - id: ripgrep
        label: ripgrep
      - id: fd
        label: fd
      - id: bat
        label: bat
      - id: jq
        label: jq
      - id: direnv
        label: direnv
      - id: lazygit
        label: lazygit
```

(`extensions:` 최상위 키는 이미 실제로 이 파일에 있음(구현 완료) — 이 문서의
`mise:` 키는 아직 구현 전.)

- `config/recommendations.default.yaml` (레포에 기본값으로 커밋, 이미 존재)
- `config/recommendations.override.yaml` (gitignore 대상, 기업/조직이 자기 이미지
  빌드할 때 이 파일만 새로 써서 완전히 다른 추천 목록으로 교체 가능)
- webmanager 백엔드가 override 있으면 override, 없으면 default를 읽어서
  `GET /api/recommendations`로 노출 (mise/extensions 공용 엔드포인트, 이미 구현됨)
- 프론트에서 카테고리별로 나열, 체크박스로 여러 개 골라서 "설치" 누르면
  `mise use -g <id>...`를 백엔드가 실행 — 아래 mise CRUD API(`POST
  /api/mise/tools`)를 그대로 재사용

## CLI 표면 조사 결과 (실제로 `mise --help`/실행해서 확인함, 2026-08-02, mise 2026.7.15)

로컬에 설치된 `mise`로 `--help` 출력 전문 확인 + 실제 명령 실행(더미 프로젝트
디렉토리에서 `jq`/`rust`/`node` 등 소형 도구로 설치/삭제/JSON 출력 왕복 테스트)까지
전부 검증함. 사전 조사(웹서치)로는 **mise를 감싸는 서드파티 웹 UI/GUI를 찾지
못함** — mise 공식은 TUI(`mise edit`)만 제공, `mise-versions.jdx.dev`는 버전
조회용 정적 웹앱이지 로컬 도구 관리 UI가 아님. 즉 이 영역은 선례에서 이어받을
"알려진 함정"이 없는 대신, 답습할 기존 설계도 없음 — 아래는 전부 이번 조사로
직접 확인한 1차 자료.

- **`mise use [-g|--path <dir>|-C <dir>] [-y] [-f] TOOL@VERSION...`**
  — 설치 + config 파일(`mise.toml`/글로벌 config)에 엔트리 기록을 한 번에 함.
  명시적 `TOOL@VERSION` 인자를 주면 프롬프트 없이 조용히 끝남(직접 확인: stdin을
  닫고 실행해도 정상 완료). `-y/--yes`는 방어적으로 항상 붙이는 걸 권장(그 외
  확인 프롬프트가 뜨는 엣지 케이스 대비). **주의**: 인자 없이 `mise use`만
  실행하면 인터랙티브 fuzzy 셀렉터로 빠짐 — 백엔드는 항상 명시적
  `TOOL@VERSION`을 넘겨야 함(bare `mise use` 절대 호출 금지). 이 경우에도 stdin이
  닫혀있으면 멈추지 않고 `No tool specified and not running interactively` 에러로
  즉시 종료함(exit 1) — 직접 확인, 행(hang) 위험 없음.
- **`mise install [-f] TOOL@VERSION...`** — config를 안 건드리고 설치만.
  존재하지 않는 도구는 `mise ERROR ... not found in mise tool registry` +
  exit 1로 명확히 실패. 진행 출력은 라인 버퍼링된 평문(`mise jq@1.8.2 [1/3]
  download`, `[2/3] verify`, `✓ installed` 등) — `exec.Command`의 stdout
  파이프를 한 줄씩 읽으면 그대로 스트리밍 가능, PTY 불필요함을 직접 확인.
- **`mise uninstall [-a] INSTALLED_TOOL@VERSION...`** — config는 안 건드림(설치된
  버전만 제거, `mise.toml`의 `[tools]` 엔트리는 그대로 남을 수 있음 — 사용자가
  다시 `mise install`하면 재설치됨). 이미 없는 버전을 지우려 해도 exit 0 +
  WARN(에러 아님) — "성공적으로 지워졌다"는 exit code만으로 단정하지 말고, 필요
  시 이후 `mise ls`로 재확인하는 편이 안전.
- **`mise ls [-g|-l|-c] [-C <dir>] [--json]`** — `--json`이 도구 이름 →
  `{version, requested_version, install_path, source:{type,path}, installed,
  active}[]` 구조로 깔끔하게 나옴. `claude mcp list`(`claude-plan.md` M5가 텍스트
  파싱 필요해서 뒤로 미뤄진 사례)와 달리 **파싱이 전혀 필요 없음**. `-C <dir>
  --local --json`으로 특정 디렉토리(cd 없이)를 지정하면 그 프로젝트 자신의
  `mise.toml`이 선언한 도구만 딱 나오고 `source.path`가 정확히 어떤 설정 파일인지
  알려줌 — 직접 테스트 확인(더미 프로젝트에 `jq = "1.7.1"`만 넣고
  `mise ls -C . --local --json` 실행 → 정확히 그 한 항목만 반환, `installed:
  false`로 미설치 상태도 구분됨). 프로젝트 탭 연동 질문(아래)의 핵심 근거.
- **`mise env [-s <shell>] [-C <dir>] [--json]`** — `--json`은 셸 문법이 아니라
  순수 key→value JSON 맵. `-C <dir>`로 실제 그 디렉토리로 이동하지 않고도 해당
  경로 기준 env를 뽑아낼 수 있음(확인 완료). 없는 도구는 stderr에 WARN만 찍고
  stdout(JSON)은 그대로 정상 반환 — stdout/stderr를 분리해서 다루면 됨.
- **`mise registry [--json]`** — `[{short, backends[], description,
  aliases[]}]` 평면 배열, 위 "카테고리별 mise 도구 추천 목록" 절의 전제(짧은 이름/
  백엔드는 `mise registry`로 재확인)가 이번에도 그대로 유효함을 재확인.
- **exit code 규약이 5개 서브커맨드 전부 일관됨**: 0 = 성공(무해한 WARN 포함),
  1 = 실제 실패 + stderr에 사람이 읽을 메시지. 서브커맨드별 예외 처리 없이 공용
  `RunMiseJSON`/`RunMiseStream` 헬퍼 하나로 다 커버 가능해 보임.
- **신뢰(trust) 프롬프트는 실질적 걸림돌 아님**: `[tools]`만 있는 일반적인
  `mise.toml`(대부분의 실제 프로젝트 설정)은 mise 자체가 "안전한 설정"으로 분류해
  프롬프트 없이 그냥 로드됨(직접 확인) — 템플릿/실행 가능한 tool-option처럼 로드
  시점에 코드가 실행되는 설정만 신뢰 프롬프트를 유발함. 문서에 한 줄 남길 가치는
  있지만 막는 요소는 아님.
- **mise 바이너리 위치가 고정 경로**: `config/code-runner.default.sh`가
  `$HOME/.local/bin/mise env --shell bash`로 직접 호출하는 걸 확인함 — 즉 컨테이너
  안에서 mise 자신은 `/code/.local/bin/mise`에 고정으로 있고(mise가 설치하는
  다른 도구들과 달리 PATH shim에 안 얹혀있음), `webmanager` supervisord
  프로그램의 PATH에 이게 잡혀 있다는 보장이 없음(`claude-plan.md`가 이미 같은
  문제를 `WEBMANAGER_CLAUDE_BINPATH`로 해결한 것과 동일 클래스의 문제). 아래
  "백엔드 설계" 절 참고.

## 기능별 실현 가능성 (사용자 제안 1~5 검증)

1. **install/use/uninstall CLI 래핑** — 그대로 감. 버전 해석 재구현 불필요 확인
   완료(위 참고).
2. **터미널 인프라 재사용(스트리밍 뷰)** — **비권장**. 아래 "스트리밍 방식" 절
   참고, 훨씬 단순한 전용 메커니즘 권장.
3. **global + per-project `mise use` 표시** — 둘 다 감. 아래 "프로젝트 탭 연동"
   절 참고, 백엔드 하나로 두 UI가 공유 가능함을 확인.
4. **설치된 도구 목록(`mise ls`)** — 그대로 감, 오히려 `claude mcp list` 케이스보다
   훨씬 쉬움(구조화 JSON 확인 완료).
5. **env 미리보기(`mise env`)** — 그대로 감, 사용자 예상대로 "쉬움"이 맞았음
   (`-C`로 임의 디렉토리 타겟 가능, JSON 그대로 사용 가능, cd 불필요).

## 백엔드 설계 (`internal/mise`, `internal/extensions`/`internal/tailscale`와 동일 패턴)

- **바이너리 탐지**: PATH 조회에 의존하지 않고 `$HOME/.local/bin/mise`(=
  `/code/.local/bin/mise`) 고정 경로를 기본값으로 사용(`code-runner.default.sh`와
  동일 관례) — `WEBMANAGER_MISE_BINPATH` 환경변수로 override 가능하게 해서
  `claudecode` 패키지의 `WEBMANAGER_CLAUDE_BINPATH` 패턴과 일관성 유지(다만 mise
  경로는 claude와 달리 사실상 고정이라 실제로 override가 필요할 상황은 드묾 — 아래
  "사용자 확인 필요" 참고).
- 모든 서브커맨드 호출에 `context.WithTimeout` 적용(claude/tailscale 패키지와
  동일한 이유 — 네트워크 I/O가 섞인 설치/registry 조회가 무한정 걸리면 안 됨).
  단 실제 설치(`install`/`use`)는 다운로드 시간이 걸릴 수 있어 타임아웃을
  조회성 커맨드(`ls`/`env`/`registry`)보다 넉넉하게 잡거나, 아예 별도 goroutine +
  잡(job) 방식으로 타임아웃 개념 자체를 없앰(아래 스트리밍 설계 참고).
- 경로 인자(`path=`)는 `review.md`의 기존 관례 그대로: 임의 경로 금지, Projects
  캐시에 이미 있는 정확한 경로만 허용(전역 뷰는 `path` 생략).
- 도구 id(`TOOL@VERSION`)는 `mise registry`의 `short` 값 기준 안전한 문자열만
  허용하는 정규식으로 검증 후 `exec.Command`에 전달(익스텐션 기능의 `publisher.name`
  정규식 검증과 동일한 이유 — 앞에 `-`가 붙으면 플래그로 오인될 위험).

## API 설계 (구현 전 상상, `dind-plan.md` 형식 참고, 재검토 필요)

```
GET  /api/mise/tools?path=<선택, 프로젝트 절대경로>
  - path 생략 → `mise ls -g --json` (글로벌 mise.toml에 선언된 도구만)
  - path 지정 → `mise ls -C <path> --local --json` (그 프로젝트 자신의
    mise.toml/.tool-versions가 선언한 도구만, path는 Projects 캐시와 정확히
    일치해야 함)

POST /api/mise/tools   body {id, version, global: bool, path?: string}
  → global: mise use -g -y <id>@<version>
  → project: mise use -C <path> -y <id>@<version>  (path 검증 필수)
  설치 + config 기록을 `mise use` 한 방으로 처리(설치만 하고 config에 안 남기는
  `mise install` 전용 엔드포인트는 v1 범위 밖 — "추천 목록에서 체크 후 설치"
  플로우는 애초에 config에 남기는 게 자연스러움)
  응답은 바로 완료 JSON이 아니라 잡 스트리밍(아래 참고)

DELETE /api/mise/tools   body {id, version, global: bool, path?: string, removeFromConfig?: bool}
  → mise uninstall <id>@<version>
  → removeFromConfig가 true면 추가로 mise use --remove <id> [-g|-C <path>] 실행
    (uninstall 자체는 config를 안 건드리므로, "완전히 빼기"를 원하면 별도 스텝
    필요 — 위 CLI 조사 결과 참고)

GET  /api/mise/env?path=<선택, 디렉토리>
  → mise env -C <path 또는 $HOME> --json 그대로 반환(값 자체가 이미 민감할 수
    있음 — API 키 같은 env var가 섞여 나올 수 있으므로 이 엔드포인트도
    webmanager의 기존 신뢰 모델 하에서만 노출, 별도 마스킹은 v1 범위 밖)

GET  /api/recommendations   (이미 구현됨, mise/extensions 공용 — 변경 없음)

--- 설치/삭제 진행 상황 스트리밍 (아래 "스트리밍 방식" 절의 폴링안 기준) ---
POST /api/mise/tools 가 즉시 {jobId} 반환(작업을 백그라운드 goroutine으로 시작)
GET  /api/mise/jobs/:id
  → {running: bool, exitCode: int|null, lines: string[]} — Projects 탭의
    `scanning: true` 폴링 패턴과 동일 모양
```

## 스트리밍 방식: 터미널(PTY/WS) 재사용 대신 전용 경량 메커니즘 권장

**결론: 재사용하지 않는 걸 권장.** 이유:

- mise 쪽 출력은 이미 한 방향(one-way) 텍스트 로그 스트림임 — 커서 제어나 화면
  다시 그리기가 있는 풀스크린 TUI가 아니라, 그냥 진행 로그 줄들이 순서대로
  나오다 끝남(위 CLI 조사에서 직접 확인). 키 입력을 되돌려 보낼 필요도 없음
  (`-y`와 명시적 `TOOL@VERSION`으로 프롬프트 자체가 발생 안 하도록 이미 통제
  가능하다는 걸 확인했으므로 stdin 연결이 아예 필요 없음). PTY는 원래 raw
  모드/ANSI 커서 제어/양방향 키 입력이 필요한 상황을 위한 것이고, 이 중 아무것도
  mise install 진행 표시에는 해당하지 않음 — PTY로 감싸는 건 평문 로그를
  터미널 시맨틱으로 한 번 왕복시키는 불필요한 레이어만 추가함.
- **결합 비용이 실재함**: `terminal-plan.md`는 지금 이 세션에서 M1이 막 착수된
  상태고, WebSocket 라이브러리 선택도 아직 안 끝남, M2(named 영속 세션)의 세션
  생명주기/재연결 설계도 미확정. mise의 설치 뷰가 같은 세션/메시지 프레이밍을
  타면, 터미널 기능이 나중에 M2에서 세션 목록/재연결/유휴 타임아웃을 설계할 때마다
  "이게 mise 잡에도 적용되나?"를 매번 따져야 하는 부담이 생김 — 정작 mise
  쪽은 그 어떤 것도 필요 없는데도. 두 기능의 구현 타임라인이 완전히 분리되는 게
  이득: mise는 터미널 M1 완료를 기다릴 필요가 없어지고, 터미널 쪽 향후 리디자인이
  mise의 설치 뷰를 실수로 깨뜨릴 걱정도 없어짐.
- **권장 메커니즘(기본안, 신규 의존성 없음)**: 이 레포가 이미 쓰고 있는 폴링
  패턴(Projects 탭의 스캔 진행 상황, Logs/Supervisor 탭)을 그대로 재사용.
  `POST /api/mise/tools`가 잡을 백그라운드로 시작하고 즉시 `{jobId}` 반환,
  프론트가 `GET /api/mise/jobs/:id`를 0.5~1초 간격으로 폴링해서 누적된
  stdout/stderr 줄과 `running`/`exitCode`를 받아 평범한 스크롤 로그
  `<pre>`/리스트에 append. xterm.js도 `creack/pty`도 필요 없음 — ANSI 파싱이
  필요 없는 순수 텍스트 로그라 일반 텍스트 뷰로 충분.
- **대안(진짜 실시간성이 필요하면)**: 청크 HTTP 응답(`http.Flusher`로 줄마다
  flush) 또는 이 기능 전용의 아주 작은 1회성 WS 엔드포인트 — 단 이 경우도
  일반 터미널 WS 엔드포인트/세션 타입과는 완전히 분리된 별도 핸들러로 유지
  (PTY 없음, 리사이즈 프로토콜 없음, 양방향 입력 없음). 처음부터 이걸로 갈
  필요는 없어 보임 — 폴링으로 시작해서 체감상 느리면 그때 업그레이드하는
  편이 안전(터미널 인프라 완성을 기다리지 않아도 되는 이점을 그대로 유지).

## 프로젝트 탭 연동: 별도 UI로 안 가르고, 백엔드 하나를 공유

`GET /api/mise/tools`/`GET /api/mise/env`를 둘 다 `path` 파라미터로 설계했으므로
(위 API 설계 참고) 이건 애초에 "mise 탭이냐 Projects 탭이냐"의 either/or가 아니라
**같은 백엔드를 두 UI가 각자 다른 시점에 호출**하는 문제로 재구성됨:

- **mise 탭**: 글로벌 뷰(`path` 생략) 중심 — 추천 목록 체크박스 설치, 글로벌
  설치된 도구 목록, 글로벌 env 미리보기. 이번 라운드의 주 구현 대상.
- **Projects 탭**: 이미 구현된 펼침형 상세 보기(`projects-plan-done.md`)에 읽기
  전용으로 "이 프로젝트가 쓰는 도구"(`GET /api/mise/tools?path=<프로젝트 경로>`)
  한 섹션만 추가 — **설치/삭제 버튼은 v1에서 넣지 않음**. 이유:
  - Projects 탭의 기존 정체성이 "읽기 전용 개요"(용량/재생성 가능 폴더/기술
    스택 뱃지)이고 유일한 액션이 좁게 스코프된 rescan뿐임 — 여기에 mise CRUD
    버튼까지 넣으면 그 정체성이 흐려짐.
  - 프로젝트 단위 `mise use`는 그 프로젝트의 `.mise.toml`/`.tool-versions`를
    직접 고쳐 씀 — 사용자가 git에 커밋해서 관리하는 파일일 수 있는 프로젝트별
    설정 파일에 UI가 대신 쓰기를 하는 것은, 순수 로컬 머신 상태인 글로벌 config
    설치보다 한 단계 더 무거운 "확인이 필요한" 결정임. 시간 압박 속에서 성급하게
    정하기보다 나중 라운드로 미루는 게 안전.
  - 백엔드가 이미 `path` 파라미터를 지원하므로, 나중에 Projects 탭에 설치/삭제
    버튼을 추가하고 싶어지면 `POST /api/mise/tools`에 `path`만 실어 보내는
    저비용 후속 작업으로 끝남 — 지금 결정을 미룬다고 나중에 아키텍처를 다시
    짜야 하는 게 아님.

## `restart` 안내가 필요한 UI 디테일 (조사 중 새로 발견)

루트 `README.md`/`CLAUDE.md`에 이미 문서화된 사실: `mise use -g`로 글로벌 도구를
바꿔도 code-server의 PATH는 즉시 반영되지 않음 — `code-runner.default.sh`가
`mise env --shell bash`를 **프로세스 시작 시점에 한 번만** 평가해서 code-server에
넘기기 때문에, 사용자가 `restart` 명령(`supervisorctl restart code-server`)을
직접 실행해야 code-server 통합 터미널에 새 도구가 나타남. mise 탭에서 글로벌
설치/삭제가 끝나면 "code-server에 반영하려면 `restart`를 실행하세요" 같은 안내를
성공 토스트에 같이 띄우는 게 좋아 보임(webmanager 자신은 `mise env`를 통해 PATH를
구성하지 않으므로 webmanager 재시작은 불필요 — code-server 쪽 안내만 필요).

## 순서/타이밍

1. `internal/mise` 패키지 + `handlers_mise.go` 신설(익스텐션 패턴 그대로),
   `GET/POST/DELETE /api/mise/tools`, `GET /api/mise/env`, 폴링 기반 잡
   스트리밍(`GET /api/mise/jobs/:id`) 먼저 구현.
2. mise 탭 프론트: 추천 목록(기존 `GET /api/recommendations`의 `mise:` 키) 체크박스
   설치 + 설치된 도구 목록 + env 미리보기.
3. Projects 탭에 읽기 전용 "이 프로젝트가 쓰는 도구" 섹션 추가(같은 백엔드
   재사용, 별도 스프린트로 미뤄도 무방 — 순수 추가라 순서 유연함).
4. 구현 시점에 `mise registry`로 위 카테고리 목록의 실제 짧은 이름/백엔드
   재확인할 것 — 이 문서의 목록은 초안일 뿐 확정 스펙 아님(기존 문구 유지).

## 참고

- 전체 우선순위/현재 상태는 `webmanager/plan.md`, `webmanager/CLAUDE.md` 참고 —
  이 문서의 go 권고에 맞춰 `webmanager/CLAUDE.md`의 큐 순서도 갱신 필요(이 문서
  범위 밖, 별도 반영).
- 익스텐션 추천/설치는 `extensions-plan-done.md`(구현 완료, 동일 shell-out 패턴의
  선례).
- 웹쉘(터미널) 설계는 `terminal-plan.md` — 이 문서가 스트리밍 재사용을
  비권장했으므로 mise 쪽 구현은 이 문서의 M1/M2 진행 상황과 무관하게 진행 가능.
- Projects 탭은 `projects-plan-done.md`.
- `claude mcp list`의 텍스트 파싱 문제(비교 대상)는 `claude-plan.md`의 M5 절.

## 사용자 확인 필요

- **Projects 탭에 mise 설치/삭제 버튼을 v1부터 넣을지**: 이 문서는 v1은 읽기
  전용(도구 목록만 표시)으로 하고 CRUD 버튼은 후속 라운드로 미루는 걸 권장함
  (근거는 위 "프로젝트 탭 연동" 절) — 그러나 이건 순수 스코프 판단이라 사용자가
  더 넓게 시작하고 싶다면 백엔드가 이미 `path` 파라미터를 지원하므로 비용 없이
  넓혀도 됨.
- **`DELETE /api/mise/tools`에서 "config에서도 제거"(`mise use --remove`) 옵션을
  체크박스로 노출할지, 아니면 언급만 하고 v1에서는 순수 `mise uninstall`만
  지원할지**: `mise uninstall`은 설치된 버전만 지우고 `mise.toml`의 `[tools]`
  엔트리는 그대로 남긴다는 게 mise 자체의 동작이라(위 CLI 조사 결과), UI가 이
  차이를 사용자에게 어떻게 보여줄지는 UX 판단의 영역.
- **스트리밍 방식으로 폴링(권장, 신규 의존성 없음) vs 청크 HTTP/전용 1회성 WS
  중 뭘 먼저 만들지**: 이 문서는 폴링을 기본안으로 권장하지만 순수 지연시간/
  체감 품질 트레이드오프라 최종 판단은 사용자 몫.
- **`WEBMANAGER_MISE_BINPATH`를 실제로 config override로 추가할지**: mise 자신의
  경로는 `claude`와 달리 `$HOME/.local/bin/mise`로 사실상 고정이라(빌드가
  이 경로를 바꿀 이유가 현재 없음) override 옵션 자체가 불필요할 수도 있음 —
  `claudecode` 패턴과의 일관성만을 위해 추가할지, 아니면 실제로 필요해지기 전까진
  생략(YAGNI)할지는 취향 판단.
