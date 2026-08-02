# 프로젝트 리스트 관리 (webmanager 신규 탭) — 1단계 완료

## 구현 완료 (2026-08-02)

이 문서의 1단계(읽기 전용) 설계대로 구현 완료. 백엔드: `internal/projects`
(`Scanner`/`NewScanner`/`TriggerScan`/`RescanOne`, `os.Open`+`ReadDir(-1)` 기반
사이즈+mtime 단일 패스 워크, `.git` 스킵, 재생성 가능 서브트리 프루닝, 워커 풀
병렬화, 마커 파일 기반 기술 스택 뱃지, atomic JSON 캐시 저장) + `handlers_projects.go`
(`GET /api/projects`, `POST /api/projects/scan`, `POST /api/projects/rescan?path=`,
경로는 캐시된 프로젝트 경로와 정확히 일치할 때만 허용). 프론트: `src/components/Projects/`
(정렬 가능 테이블, 펼침형 재생성 가능 폴더 브레이크다운, 스캔 중 폴링, code-server
열기 버튼 분리). `go build`/`go vet`/`gofmt`, `npm run build`/`npm run lint` 전부
클린 확인.

**설계 문서 대비 의도적 변경 하나**: 사용자 정의 재생성 패턴 파일을 아래 "재생성
가능 폴더 판별" 절이 제안한 루트 `config/webmanager-projects.default.yaml`(Dockerfile
빌드 시점에 굳는 override) 대신, `internal/projects`에 `go:embed`로 기본값을
내장하고 `/code/.webmanager/projects-patterns.yaml`이 없으면 최초 읽기 시점에 그
내장 기본값으로 시드하는 방식으로 구현 — 리빌드 없이 사용자가 바로 편집 가능.

**2단계(삭제 기능)는 여전히 미구현** — 아래 "2단계 (이후, 이 문서 범위 밖): 삭제"
절 그대로 남아있는 설계.

---

# 원 설계 문서 (구현 전 설계, 우선순위 중간)

## 동기

`$HOME/Projects` 아래 프로젝트들이 `node_modules`, cargo `target` 같은
의존성/빌드 산출물 때문에 용량을 크게 먹는 경우가 잦음. 프로젝트 자체를 지우긴
애매하지만(다시 쓸 수도 있음), 의존성/빌드 캐시는 언제든 재생성 가능하니 그것만
찾아서 정리하고 싶음. 부수적으로 프로젝트별 크기를 한눈에 보고, 오래 안 건드린
프로젝트를 찾아내는 것도 도움이 됨.

추가로: code-server의 "최근 열었던 폴더" 목록은 브라우저 로컬 스토리지에 저장되기
때문에 기기/브라우저마다 따로 놀아서, 어떤 기기에서 최근에 뭘 열었는지 서로 안
보임. 이 기능이 어차피 프로젝트별 최근 수정 시각을 스캔하니, 그걸 "최근 편집
프로젝트" 뷰로도 겸하게 하고 — 목록에서 프로젝트를 클릭하면 바로 code-server로
들어가지는 것까지 되면 기기 상관없이 쓸 수 있는 프로젝트 런처 역할까지 함(실사용
수요 있음).

## 스캔 루트

- 설정값 이름: `WEBMANAGER_PROJECTS_PATH` (다른 config들과 동일하게 `config.go`의
  `getenv` 패턴 — env var, 기본값 `/code/Projects`).
- **`:` 구분 다중 경로 지원** — `PATH` 관용을 그대로 따름. Android 프로젝트처럼
  기본 `Projects` 트리 밖에 놓인 경로도 별도로 추가할 수 있어야 함(예:
  `/code/Projects:/code/AndroidStudioProjects`).
- 각 루트 디렉토리의 **1단계 하위 디렉토리**를 "프로젝트"로 취급(디렉토리 자체가
  `.git`이나 마커 파일을 갖고 있는지는 검사하지 않음 — 단순히 "루트 바로 아래
  폴더 = 프로젝트" 규칙으로 충분, 마커 파일 검사는 그 프로젝트 *내부*의 재생성
  가능 폴더를 찾는 데만 씀).

## 1단계 범위: 읽기 전용 (이 문서가 다루는 전부)

삭제 기능은 명시적으로 2단계로 미룸. 1단계는:

- 프로젝트별 총 용량
- 프로젝트별 "재생성 가능" 폴더 목록 + 각각의 용량(node_modules 몇 GB, target 몇
  GB 식으로 브레이크다운)
- "오래된 프로젝트" 플래그
- 기술 스택 뱃지(Node.js/Rust/Python/... — 마커 파일 기반)
- code-server로 바로 열기(URL이 설정돼 있을 때) + 최근 편집순 정렬

## 재생성 가능 폴더 판별

**고정 패턴 목록**(디렉토리 이름 기준, 마커 파일과 무관하게 어디서 발견되든
후보로 표시) + **사용자 정의 패턴 추가** 두 가지를 합쳐서 판별.

초기 고정 목록(디렉토리 이름 매칭):

| 패턴 | 보통 등장 컨텍스트 |
|---|---|
| `node_modules` | npm/yarn/pnpm |
| `target` | Cargo, Maven |
| `.venv`, `venv` | Python |
| `__pycache__` | Python |
| `dist`, `build` | 범용 빌드 산출물 (JS 번들러, gradle 등) |
| `.next`, `.nuxt` | JS 프레임워크 캐시 |
| `.turbo` | Turborepo 캐시 |
| `.gradle` | Gradle 로컬 캐시(Android 프로젝트 커버) |
| `.cache` | 범용 |

- 마커 파일(`package.json`, `Cargo.toml`, `pyproject.toml`, `build.gradle*` 등)로
  프로젝트 타입을 먼저 식별하고 그에 맞는 패턴만 찾는 방식도 고려했지만, 패턴
  이름 자체가 이미 충분히 구체적이라(예: `node_modules`라는 이름의 폴더가
  npm과 무관하게 존재할 가능성은 사실상 없음) **마커 파일 식별 없이 이름
  매칭만으로 충분**하다고 판단 — 구현이 훨씬 단순해짐. 추후 오탐이 실제로
  발견되면 그때 마커 파일 교차 검증을 추가.
- 사용자 정의 패턴: override 패턴과 동일한 사상으로, config 파일
  (`config/webmanager-projects.default.yaml` + 사용자 override) 에 `patterns:`
  리스트로 추가 항목을 얹을 수 있게 함(예: `.terraform`, `vendor/`). 신규
  파일로 결정 — 이유는 아래 "남은 결정" 참고.
- 탐색 시 **재생성 가능 폴더로 매칭되면 그 안으로는 더 들어가지 않고 크기만
  합산** — `node_modules` 내부의 수만 개 파일을 굳이 하나씩 stat할 필요 없이
  해당 서브트리 총 바이트만 필요하기 때문.

### 크기 계산: `du` shell-out이 아니라 Go 자체 재귀 (결정)

디렉토리 크기는 결국 파일마다 stat을 떠야 나오는 값이라(디렉토리 자체 메타데이터
만으로는 안 나옴) `du`든 직접 구현이든 이 syscall 비용 자체는 못 피함 — 그래서
차이는 그 위에 붙는 오버헤드뿐임. `du -sb`로 하면 재생성 가능 폴더/프로젝트마다
프로세스를 매번 fork/exec 해야 하는데, 스캔 한 번에 이게 수십~수백 번 반복될 수
있어서 이 오버헤드가 누적됨. Go 자체 재귀 구현이면:

- 프로세스 생성 비용 없음.
- `os.ReadDir`(패키지 함수)는 내부적으로 파일명 정렬을 하는데, `node_modules`처럼
  엔트리 수가 많은 디렉토리에서 이 정렬 비용이 은근히 큼 — 대신 `os.Open` 후
  `(*os.File).ReadDir(-1)`을 직접 써서 정렬을 건너뜀(순서는 어차피 안 씀, 합산만
  하니까).
- 프로젝트 단위(서로 독립적인 트리)로 워커 풀을 돌려 병렬화하기 쉬움 — `du`
  프로세스를 여러 개 동시에 띄우는 것도 가능은 하지만 관리가 더 번거로움.
- 심볼릭 링크는 따라가지 않음(`Lstat` 사용, `du`의 기본 동작과 동일) — 순환
  참조로 무한루프에 빠지거나 프로젝트 트리 밖의 내용을 잘못 합산하는 걸 방지.

새 의존성 불필요(표준 라이브러리만으로 충분), 도커 컨테이너 안에서만 도니까
크로스플랫폼 고려도 없음 — 구현 자체는 간단한 편.

## 기술 스택 표시

프로젝트 카드/행에 뱃지로 "이 프로젝트가 뭘로 만들어졌는지"를 보여줌(Node.js,
Rust, Python, Go, Android/Gradle 등). "재생성 가능 폴더 판별"에서는 마커 파일
검사를 일부러 생략했지만, 이 표시 기능은 애초 목적이 다르므로(사용자에게 정보
표시용) 마커 파일 존재 여부를 그대로 씀 — 겹치는 검사가 아니라 별개 용도.

- 마커 파일 → 뱃지 매핑(1단계, 단순 존재 여부만):
  `package.json`→Node.js, `Cargo.toml`→Rust, `pyproject.toml`/`requirements.txt`→
  Python, `go.mod`→Go, `build.gradle`/`build.gradle.kts`→Gradle/Android,
  `pom.xml`→Maven, `composer.json`→PHP.
- 패키지 매니저/프레임워크까지 세분화(예: `package.json`의 `packageManager` 필드로
  npm/yarn/pnpm/bun 구분, `dependencies`로 React/Next/Vite 추정)는 **1단계
  범위 밖** — 뱃지 하나로도 목적(한눈에 뭔지 알아보기)은 충분히 달성되고,
  `package.json` 파싱까지 들어가면 언어별로 규칙이 제각각이라 복잡도가 급격히
  올라감. 나중에 수요 있으면 마커 파일당 하나씩 점진적으로 추가.
- 한 프로젝트에 마커가 여러 개 매칭될 수 있음(예: 모노레포에 `package.json` +
  `Cargo.toml` 공존) — 뱃지는 배열이라 여러 개 그대로 표시, 대표 하나로 좁히지
  않음.

## code-server에서 바로 열기

프로젝트 행 클릭 시 code-server로 해당 폴더를 열어 바로 편집 들어갈 수 있게 함.

- webmanager는 code-server가 **외부에서 실제로 어떤 URL로 접근되는지 모름**
  (`code-config.default.yaml`은 `auth: none`으로 로컬 바인딩만 알지, 앞단
  리버스 프록시/도메인은 별개) — 그래서 새 config 값이 필요함:
  `WEBMANAGER_CODE_SERVER_URL`(외부 접근 가능한 code-server 베이스 URL). 비어
  있으면 "열기" 버튼을 숨김(선택 기능이지, 필수 아님).
  **자동 유추는 하지 않음** — tailscale publish나 다른 설정에서 도메인을
  역산하는 방식도 고려했지만, 예상 못 한 케이스(멀티 인스턴스, `PREFIX`,
  리버스 프록시가 여러 단인 경우 등)에서 잘못된 URL을 만들어낼 위험이 있어서
  사용자가 직접 값을 넣게 함(다른 대부분 config와 동일한 방식).
- URL 스킴 **확인 완료** — 실제 배포 예시:
  `https://code.yaeji.moe/?folder=/code/Projects/nekolog`. 즉
  `${WEBMANAGER_CODE_SERVER_URL}/?folder=${프로젝트 절대경로}` 조립으로 확정,
  더 이상 가정이 아님.
- 이 클릭-진입 기능은 자연스럽게 "최근 편집 프로젝트" 뷰와 묶임 — 이미 스캔에서
  구하는 `lastModified` 기준으로 정렬한 목록이 곧 기기 무관 "최근 프로젝트"
  런처가 됨(동기 섹션 참고). 별도 데이터 소스나 API 불필요, 정렬 옵션 하나로
  겸함.

## 오래된 프로젝트 탐지

- 프로젝트 디렉토리 내 파일들의 최신 mtime을 기준으로 "N일 이상 안 건드림"
  플래그. **재생성 가능 폴더로 매칭된 서브트리는 mtime 스캔에서 제외** — 안
  그러면 `npm install`을 최근에 돌렸다는 이유만으로 실제로는 안 건드린
  프로젝트가 "최근 활동"으로 오탐됨.
- N일 임계값은 설정 가능하게(기본값 90일 — "남은 결정" 참고, override로 조정 가능).

## 캐싱 & 온디맨드 스캔 (사실상 이 기능의 핵심 동작 방식)

전체 스캔은 느릴 수 있으니 **매 요청마다 다시 돌지 않고, 디스크에 캐싱된 마지막
결과를 즉시 반환**하는 걸 기본으로 함. 새로고침은 아래 세 경로로만 일어남 —
자동 백그라운드 폴링은 없음(Processes 탭과 달리 이 데이터는 실시간성이 필요
없고 디스크 I/O 비용이 큼):

1. **개별 프로젝트 새로고침** — 목록에서 프로젝트를 펼쳐 "자세히 보기" 상태로
   들어갈 때, 그 프로젝트의 캐시된 `scannedAt`이 임계값(가칭
   `WEBMANAGER_PROJECTS_STALE_AFTER`, 기본 1시간)보다 오래됐으면 그 프로젝트
   **하나만** 자동으로 다시 스캔. 다른 프로젝트는 건드리지 않아서 저렴함.
2. **개별 프로젝트 수동 새로고침 버튼** — 위 자동 조건과 무관하게, 방금 스캔
   했어도 사용자가 원하면 바로 다시 스캔 가능.
3. **전체 다시 스캔 버튼** — 모든 루트/프로젝트를 처음부터 재스캔(비쌈, 남발할
   기능은 아니라서 목록 상단에 하나만 둠).

캐시 저장소: 웹매니저가 여태 자체 영속 상태 파일을 가진 적이 없었음(다른 config
값들은 전부 *다른* 시스템의 설정 파일 경로일 뿐 — `SSHKeysDir`, `TailscaleConfigPath`
등) — 이 기능이 최초 사례. `.ssh`/`.tailscale`/`.vector`/`.claude`처럼 `/code`
바로 아래 점 디렉토리를 쓰는 기존 관례를 그대로 따라 `/code/.webmanager/`를
webmanager 자체 상태 디렉토리로 새로 도입, 캐시 파일은
`/code/.webmanager/projects-cache.json`(config: `WEBMANAGER_PROJECTS_CACHE_PATH`).
JSON을 쓰는 이유는 이 파일이 순수 기계 생성/기계 판독용이라(사용자가 손으로 편집
할 이유 없음) 사람이 읽기 편한 YAML보다 표준 라이브러리만으로 빠르게 파싱되는
JSON이 더 적합해서 — 반면 위에서 나온 "사용자 정의 재생성 패턴" 쪽은 사람이 직접
고쳐 쓰는 파일이라 override 관례에 맞춰 YAML 유지(둘의 성격이 다름).

캐시가 아예 없는 최초 실행(첫 `GET`)은 어떻게 하나: **막지 않고 백그라운드로
스캔 시작, 즉시 `{"scanning": true}` 형태로 응답, 프론트는 완료될 때까지 짧은
간격으로 다시 `GET`**(Logs/Supervisor 탭이 이미 쓰는 폴링 패턴과 동일 — 이
저장소에 스트리밍/WS 선례가 없어서 새 패턴을 안 만들어도 됨). 동기로 블로킹하는
방식은 트리가 크면 리버스 프록시 타임아웃에 걸릴 위험이 있어서 배제.

동시성: 이미 스캔이 진행 중인데 또 스캔 요청이 오면(브라우저 탭 두 개 동시
클릭 등) 새로 스캔을 또 띄우지 않고 진행 중인 스캔의 완료를 같이 기다리게
함(in-flight 스캔 하나로 합침) — 대상이 겹치는 스캔을 동시에 여러 개 돌릴
이유가 없음.

## API 스케치 (구현 전 상상, 재검토 필요)

- `GET /api/projects` — 캐시에서 즉시 반환(스캔 중이면 `scanning: true`만 담아
  반환). 응답 형태(가안):
  ```json
  {
    "roots": ["/code/Projects", "/code/AndroidStudioProjects"],
    "scanning": false,
    "scannedAt": "2026-08-02T12:00:00Z",
    "projects": [
      {
        "root": "/code/Projects",
        "name": "code-docker",
        "path": "/code/Projects/code-docker",
        "totalSizeBytes": 123456789,
        "reclaimableSizeBytes": 98765432,
        "reclaimable": [
          {"pattern": "node_modules", "path": ".../node_modules", "sizeBytes": 90000000}
        ],
        "lastModified": "2026-07-01T00:00:00Z",
        "stale": true,
        "techStack": ["Node.js"],
        "scannedAt": "2026-08-02T12:00:00Z"
      }
    ],
    "codeServerUrl": "https://code.example.com"
  }
  ```
  `scannedAt`이 최상위(전체 마지막 전체 스캔 시각)와 프로젝트별로 둘 다 있는 이유:
  개별 새로고침이 프로젝트 단위로 캐시를 부분 갱신하니, 프로젝트마다 실제 최신
  시각이 서로 달라질 수 있어서. `codeServerUrl`은 `WEBMANAGER_CODE_SERVER_URL`
  config 값을 그대로 실어 보냄(프론트가 `${codeServerUrl}/?folder=${path}` 조립 —
  비어 있으면 "열기" UI 숨김). 프로젝트 객체 자체에 완성된 열기 URL을 넣지 않는
  이유는 베이스 URL이 전체 응답에 하나뿐이라 항목마다 반복할 필요가 없어서.
- `POST /api/projects/scan` — 전체 다시 스캔 트리거(비동기 시작, 위 `GET`과 동일
  응답 형태를 바로 반환하되 `scanning: true`).
- `POST /api/projects/rescan?path=<프로젝트 절대경로>` — 프로젝트 하나만 다시
  스캔(경로는 캐시에 이미 있는 프로젝트의 정확한 경로만 허용 — 임의 경로 스캔
  방지, `.claude/archive/webmanager-review.md` (레포 루트)의 경로 검증 관례와 동일). 완료 후 갱신된 프로젝트 객체
  하나만 반환.

## 프론트 스케치

- `src/components/Projects/` — 프로젝트 카드/테이블 목록, 정렬(용량순/최근
  수정순), "오래됨" 배지, 기술 스택 뱃지. 기존 `Processes`/`ProcessTable`
  패턴(정렬 가능한 테이블)을 참고.
- 우측 상단에 "전체 다시 스캔" 버튼 + 마지막 전체 스캔 시각 표시.
- 기본 정렬을 "최근 수정순"으로 두면 곧 "최근 편집 프로젝트" 뷰가 됨(별도 탭
  불필요).
- **두 가지 클릭 동작을 분리**(하나로 합치지 않음):
  - **행 클릭/펼치기 = "자세히 보기"** — 재생성 가능 폴더 브레이크다운을
    펼쳐서 보여줌. 이때 그 프로젝트의 `scannedAt`이 오래됐으면(위 "캐싱 &
    온디맨드 스캔" 참고) 자동으로 `POST /api/projects/rescan`을 쏴서 갱신,
    펼친 영역 안에 프로젝트 전용 "새로고침" 버튼도 항상 노출.
  - **"code-server에서 열기" 버튼(행 안의 별도 아이콘/버튼) = 실제 이동** —
    `codeServerUrl`이 설정돼 있을 때만 노출, 클릭 시 새 탭으로 이동. 행을
    펼치는 클릭과 겹치지 않게 별도 버튼으로 명확히 분리(오탐으로 code-server가
    자꾸 새 탭으로 열리는 걸 방지).

## 2단계 (이후, 이 문서 범위 밖): 삭제

- 재생성 가능 폴더 단위로 삭제 버튼 — `.claude/archive/webmanager-review.md` (레포 루트)의 기존 보안 패턴을 그대로
  따름: 삭제 대상 경로는 스캔 결과로 나온 정확한 경로만 허용(사용자 임의
  경로 입력 금지), 매 삭제는 confirm 다이얼로그 필수(예외 없음 규칙).
  프로젝트 자체(최상위 디렉토리) 삭제는 이 기능 범위에 포함하지 않음 — 재생성
  불가능한 데이터라 실수 시 되돌릴 수 없어서, 하려면 완전히 별도의 훨씬 무거운
  확인 절차가 필요함(범위 밖으로 명시적으로 제외).

## 실현 가능성 검토 결과

막히는 기술적 요소 없음. 새 외부 의존성도 불필요 —
`gopkg.in/yaml.v3`(사용자 정의 패턴 config용)는 이미 `go.mod`에 있고, 크기
계산/디렉토리 순회/캐시 파일 읽고 쓰기는 전부 표준 라이브러리로 충분. `/code`가
바인드 마운트(`docker-compose.yml`)라 새 상태 디렉토리(`/code/.webmanager/`)도
기존 `.ssh`/`.tailscale`/`.vector`/`.claude`처럼 재부팅 후에도 그대로 남음.
난이도는 dind/웹쉘보다 낮고 익스텐션 관리 기능과 비슷한 급 — 결정 포인트가
막혀서 못 넘어가는 지점은 없음.

## 남은 결정(구현 시 정하면 되는 사소한 값, 지금 안 막힘)

- `WEBMANAGER_PROJECTS_STALE_AFTER`(개별 프로젝트 자동 새로고침 임계값) 기본값
  — 1시간으로 가정, 필요하면 조정.
- "오래된 프로젝트" N일 임계값 기본값 — 90일로 가정.
- 사용자 정의 재생성 패턴 config 파일명 — `config/webmanager-projects.default.yaml`
  신규 생성으로 결정(기존 `recommendations.yaml`은 mise/익스텐션 추천용이라
  성격이 달라서 안 얹음).
- 워커 풀 동시성 수치(프로젝트 단위 병렬 스캔 시 goroutine 개수 상한) — 구현
  하면서 CPU 코어 수 기준으로 정하면 됨, 지금 결정할 필요 없음.

두 값(스테일 임계값, N일 임계값)은 전부 config override로 바뀌니 기본값이 마음에
안 들면 나중에 언제든 바꿀 수 있음 — 지금 확정 안 해도 진행에 지장 없음.
