# Docker/dind 관리 (M1+M2+M3 구현 완료) — 실컨테이너 QA 대기

## 구현 완료 (2026-08-03): M1 (읽기 전용)

아래 "구현 방향" 절의 리서치 결론 그대로: `internal/dind`(plain 함수, `Client`
구조체 없음)가 `os/exec`로 `docker` CLI를 셸아웃 — 새 의존성 없음. `docker ps -a
--no-trunc --format json`/`docker images --no-trunc --format json`을 한 줄당 JSON
객체로 파싱, `docker logs --timestamps --tail N [--since <unix초>]`는 컨테이너
자신의 stdout/stderr를 한 버퍼에 합쳐서 반환(`docker`가 낸 진짜 에러 메시지와
섞이지 않도록 list류와는 별도 exec 경로 사용 — 코드 주석 참고).

`GET /api/dind/containers`, `GET /api/dind/images`,
`GET /api/dind/containers/{id}/logs?tail=&since=` 3개 전부 읽기 전용이라 비밀번호
게이트 없음(계획대로). 컨테이너/이미지 ID는 `gitconfig/gpg.go`의 fingerprint
정규식과 같은 패턴으로 `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$` 검증 후에만
`exec.Command`에 전달, `since`는 순수 자릿수(unix초)만 허용 — 둘 다 플래그 주입
방지. 프론트는 `src/components/Dind/`(Dind.tsx가 컨테이너/이미지 서브탭 전환,
ContainerTable/ImageTable/DindLogPanel) — Task Manager의 서브탭 CSS
(`processes-tab`)와 Supervisor의 LogPanel 패턴(Sheet 재사용, 폴링 없이 수동
새로고침)을 그대로 재사용. 5초 폴링으로 목록 갱신. `go build`/`go vet`/`gofmt`,
`npm run build`/`npm run lint` 전부 클린 — 실컨테이너(`docker compose up`) 통합
확인은 아직 안 함.

**아래 "사용자 확인 필요" 절의 `docker inspect` 상세 뷰 질문은 M1 스코프에서
뺐음**(list/logs만으로 M1 완결, inspect는 별도 라운드로 미룸 — 질문 자체는 아직
유효).

## 구현 완료 (2026-08-03): M2 (start/stop/remove)

아래 "위험 완화" 절 그대로: `internal/dind`에 `StartContainer`/`StopContainer`/
`RemoveContainer`(plain 함수, M1과 동일 패턴)를 추가해 각각 `docker
start|stop|rm [-f]`로 셸아웃, 컨테이너 ID는 M1과 같은
`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$` 정규식(`ValidateID`)을 그대로 재사용.
`POST /api/dind/containers/{id}/start|stop|remove` 3개 핸들러
(`handlers_dind.go`)는 `main.go`에서 `gate.RequirePassword`로 감싸 비밀번호
게이트 적용 — Supervisor의 start/stop/restart와 동일한 배선. 삭제 강제 여부는
`?force=true` 쿼리 파라미터로만 명시적으로 켤 수 있고, 기본값(force 없음)은 항상
`docker rm`(정지된 컨테이너만 성공) — 실행 중 컨테이너의 암묵적 강제 삭제는 없음.
액션마다 `log.Printf` 한 줄로 감사 로그(선택 사항이었지만 거의 공짜라 추가함).

프론트(`src/components/Dind/ContainerTable.tsx`)는 각 행에 시작/정지/삭제 버튼을
추가 — 셋 다 `window.confirm` 확인 다이얼로그 필수(예외 없음, Supervisor
`ProcessTable.tsx`의 `confirmAction` 패턴과 동일하게 재사용, 별도 다이얼로그
컴포넌트는 이 저장소에 애초에 없음). 삭제 확인 문구는 M1이 이미 받아온 목록 데이터의
`state` 필드로 실행 중 여부를 판단(새 fetch 없음): 실행 중이면 "강제 삭제하면
즉시 종료(kill)됩니다, 먼저 정지 버튼으로 정지 후 삭제하세요"를 명시하고 확인 시
`force=true`로 호출, 정지/생성 상태면 일반 삭제 문구로 `force` 없이 호출. 액션
성공 시 `Dind.tsx`가 즉시 `load()`를 재호출해 5초 폴링을 기다리지 않고 목록을
새로고침. `go build`/`go vet`/`gofmt`, `npm run build`/`npm run lint` 전부
클린 — 실컨테이너(`docker compose up`) 통합 확인은 M1과 마찬가지로 아직 안 함,
출시 전 권장.

---

## 원본 계획 (리서치 라운드, 2026-08-02 — 위 M1 구현으로 대체된 부분 제외하고는
여전히 유효)

`research/caddy-plan.md`에서 확정된 우선순위: **웹쉘보다 먼저** 진행 (`archive/terminal-plan-done.md` 다음
이 아니라 그 앞 — 전체 순서는 `webmanager/CLAUDE.md` 참고). 이번 라운드는 사용자
요청으로 **리서치만** 진행(라이브러리 선택, 위험 완화, 로그 스트리밍) — 구현은
여전히 시작 안 함.

## 알려진 것

- `DOCKER_HOST=tcp://dind:2375`로 이미 평문 TCP 도달 가능(인증/TLS 없음,
  `code-docker-internal` 전용) — Docker Engine API를 그대로 웹 UI 백엔드에서 호출
  하면 됨, 새 인증 계층 불필요(기존 신뢰 경계 재사용).
- **주의**: 이 API는 사실상 호스트 루트 권한과 동급 — webmanager 자체의 (없는) 인증이
  곧 이 API의 유일한 문지기가 됨(README의 기존 dind 보안 각주와 동일 성격). 아래
  "위험 완화" 절에서 `archive/terminal-plan-done.md`의 인증 절과 같은 급으로 다룸.
- `docker` CLI가 이미 이미지에 설치돼 있고(루트 Dockerfile, `docker-bin` 스테이지)
  `DOCKER_HOST`만 가리키면 그대로 dind 데몬에 붙는다 — 로컬 확인 결과 이 이미지의
  docker CLI(29.6.2)는 `docker ps/images/inspect` 모두 `--format json`(순수 JSON,
  템플릿 아님)을 지원하고, `docker inspect`는 애초에 JSON 네이티브 출력이다.

## API 초안 (구현 전 상상, 재검토 필요)

`GET /api/dind/containers`, `GET /api/dind/images`,
`POST /api/dind/containers/:id/start|stop|remove`,
`GET /api/dind/containers/:id/logs`(스트림) — Docker Engine API를 얇게 프록시/래핑.

**범위 명시(이번 리서치로 확정, 아래 "위험 완화" 절 참고)**: 위 목록이 v1의 전체
범위다. `docker run`(임의 이미지+마운트+privileged), `docker exec`(실행 중인
컨테이너에 셸 진입), `docker cp`, 네트워크/볼륨 조작, "풀 후 바로 실행" 플로우는
API 초안에 아예 포함하지 않는다 — 나중에 필요해지면 별도 라운드에서 그 자체를
`archive/terminal-plan-done.md`의 인증 절과 동급의 보안 각주와 함께 재검토.

## 구현 방향 (리서치 결과, 확정)

### 1. 라이브러리 선택: CLI 셸아웃 확정 (공식 SDK·raw HTTP 클라이언트 모두 기각)

**결론**: 새 의존성 추가 없음. `/usr/bin/docker` CLI를 `exec.Command`로 호출하고
`--format json`(`docker ps`, `docker images`) / 네이티브 JSON(`docker inspect`)을
그대로 파싱한다. 로그는 `docker logs --follow`, 이벤트가 필요해지면
`docker events --format json`.

**근거**:

- 이 저장소의 백엔드 `go.mod`는 현재 직접 의존성 3개뿐(`gopsutil`, `x/crypto`,
  `yaml.v3`) — "가벼운 의존성" 원칙이 문서상 선언이 아니라 실제로 지켜지고 있다.
- 공식 SDK 확인 결과(2025년 `moby/moby`가 client 모듈을 `github.com/moby/moby/api`
  기반으로 재정리한 이후에도): `github.com/docker/docker/client`는 직접
  의존성만 14개 — OpenTelemetry 3종(`otel/trace`, `otelhttp` 계측 포함),
  `containerd/errdefs`, Windows 전용인 `Microsoft/go-winio`(이 컨테이너는
  Linux 전용이라 완전히 죽은 무게), `go-cmp`, `gotest.tools` 등. 이 기능의 실제
  필요(list/start/stop/remove/logs)에 비해 명백히 과한 트리 — 특히 OpenTelemetry
  계측은 이 코드베이스 어디에도 없는 완전히 새로운 관측 스택 카테고리를 끌어들인다.
- 기존 컨벤션과의 일치: git/gpg/ssh-keygen 전부 `exec.Command` + 엄격한 입력 검증
  (예: `gitconfig/gpg.go`의 40자리 hex fingerprint 정규식, `exec.Command`에 넘기기
  전에 검증)로 셸아웃한다. 유일하게 CLI 대신 구조화된 API를 쓴 사례인 Supervisor도
  살펴보면(— `internal/supervisor/{client,xmlrpc}.go`), 실은 **서드파티 라이브러리를
  들이지 않고 `net/http` + `encoding/xml`만으로 XML-RPC 클라이언트를 직접 손으로
  짠 것**이다. 이유는 명확: `supervisorctl`의 텍스트 출력이 구조화되어 있지 않아서
  파싱이 오히려 더 지저분해지기 때문. Docker CLI는 그 문제가 없다(`--format json`이
  네이티브로 존재) — 즉 supervisor 사례가 실제로 보여주는 원칙은 "CLI를 무조건
  선호"가 아니라 "최소 의존성으로 구조화된 데이터를 얻는 방법을 고른다"이고, dind는
  CLI 셸아웃이 그 원칙을 라이브러리 없이도 그대로 만족시키는 케이스다. raw HTTP
  클라이언트(supervisor와 동일하게 직접 짜는 방식)를 CLI 대신 쓸 이유가 없다.
- raw HTTP 클라이언트를 직접 짜는 방안도 검토했으나 기각: CLI가 이미 JSON을 주는
  마당에 얻는 이점이 없고, 로그 스트림의 경우 오히려 손해다 — Engine API를 TTY
  없이 직접 치면 stdout/stderr가 8바이트 헤더로 멀티플렉싱된 프레임으로 오므로
  직접 디코딩 코드를 새로 짜야 하는데, `docker logs -f`는 이미 그 디먹싱을 CLI가
  대신 해줘서 순수 텍스트 라인만 나온다.
- 스트리밍(로그 follow, 향후 필요하면 `docker events`)은 `exec.CommandContext` +
  stdout 파이프가 가장 단순하고 정확한 패턴 — context 취소로 프로세스가 확실히
  죽고, 수동 디먹싱이 필요 없고, 별도 소켓/고루틴 누수 걱정이 CLI 자체 프로세스
  생명주기 관리로 흡수된다.

### 2. 위험 완화: v1 범위를 list/start/stop/remove/logs로 명시적으로 한정

**결론**: `docker run`/`docker exec`/`docker cp`는 v1뿐 아니라 당분간 아예 범위
밖. 시작/정지/삭제는 기존 ground rule대로 예외 없이 확인 다이얼로그. 읽기 전용
(목록/로그 조회)을 먼저 출시하는 걸 권장.

**근거**:

- `archive/terminal-plan-done.md`의 인증 절은 웹쉘을 "webmanager 전체에서 가장 강력한 단일
  권한"이라고 명시하고, 그래서 M1은 임시 세션으로 범위를 좁히고 별도 비밀번호
  게이트를 나중에 얹는 방향까지 이미 구체적으로 설계해뒀다. `docker exec`(실행 중인
  임의 컨테이너에 셸 진입)와 `docker run --privileged -v ...`(임의 마운트/특권
  컨테이너 생성)는 정확히 같은 등급의 권한이다 — 오히려 더 넓을 수 있다: 웹쉘은
  code-docker 자신의 셸 하나로 제한되지만, `docker exec`는 dind 안의 *임의*
  컨테이너를 대상으로 할 수 있고 `docker run`은 호스트 경로 마운트나 privileged
  플래그까지 UI 버튼 하나로 노출시킨다. 이걸 dind v1에 포함시키면 터미널이 신중하게
  좁혀놓은 것과 동급이거나 그 이상인 두 번째 "루트 셸급" 표면을 별도 비밀번호
  게이트 계획도 없이 만드는 셈이 된다. 그래서 exec/run은 웹쉘의 비밀번호 게이트가
  실제로 착수될 시점에(또는 그 이후) 별도 라운드로 재검토하는 걸 권장하고, 지금
  범위에서는 뺀다.
- 다만 이 스코프 축소가 "공격자를 막는" 조치는 아니라는 점을 분명히 해야 한다:
  `code-docker-internal`에 닿을 수 있는 누구든 이미 인증 없는 Engine API에 직접
  `curl`/`docker` CLI로 접근해 exec/run/cp를 그대로 할 수 있다(README에 이미
  "호스트 커널급 권한"으로 문서화됨) — webmanager가 UI를 안 만든다고 그 경로가
  막히는 게 아니다. 이 스코프 제한의 실질적 가치는 **신뢰된 운영자 본인의 실수
  방지**(버튼 클릭 한 번으로 `docker run --privileged -v /:/host` 같은 걸 저지르는
  구조적 함정을 애초에 안 만드는 것)이지, 신뢰 경계 자체를 좁히는 게 아니다 —
  터미널의 비밀번호 게이트가 forward-auth를 대체하는 게 아니라 그 위에 얹는
  defense-in-depth인 것과 같은 프레이밍.
- 확인 다이얼로그: `webmanager/CLAUDE.md`의 ground rule("모든 파괴적 프론트엔드
  액션은 예외 없이 확인 다이얼로그" — Supervisor 탭에 없어서 실제 사고가 났던
  전례)이 여기도 그대로 적용된다. start/stop/remove 전부 확인 다이얼로그 필수,
  예외 없음. `docker rm`이 실행 중인 컨테이너엔 `-f`가 필요하다는 점도 UI 문구에
  반영할 것(실행 중 컨테이너 삭제 시도는 "먼저 정지하시겠습니까" 안내 또는 강제
  삭제임을 명확히 알리는 별도 문구).
- 읽기 전용 우선 출시: 권장. 이 저장소에 이미 Projects 탭이 "1단계 읽기 전용(용량/
  재생성 가능 폴더 탐지) → 2단계 삭제 UI"로 나눈 전례가 있다(`qa-request/projects-plan-done.md`
  / `CLAUDE.md` 큐 항목 2번). dind도 동일하게 자연스러운 M1/M2로 나뉜다: **M1 =
  목록(containers/images) + inspect 상세 + 로그 조회(follow 없이도 우선 가치 있음)**,
  **M2 = start/stop/remove(확인 다이얼로그 포함)**. M1은 뮤테이션이 전혀 없어
  위험도가 훨씬 낮고, 그 자체로 "지금 dind 안에 뭐가 떠 있는지 웹에서 바로 보인다"는
  실사용 가치가 이미 크다(README의 dind 사용 시나리오 — `docker run`으로 만든
  redis/postgres 등이 뭐가 떠있는지 code-docker 셸 없이 확인 가능).
- 추가 가드레일 검토 결과:
  - **컨테이너 이름 allowlist/denylist**: 권장하지 않음. 코드베이스 전체를 확인한
    결과 이런 종류의 가드레일(allowlist/denylist/rate-limit) 전례가 어디에도 없고,
    이 도구는 애초에 "dind 안에서 `docker run`으로 뭐든 띄워서 쓰는" 것 자체가
    README에 명시된 핵심 사용법(개인용 단일 사용자 devbox)이라, 이름 기반 제한은
    정당한 사용(예: README 예시의 `mypg`)을 막을 뿐 실질적 보안 이득이 없다.
  - **rate limiting**: 같은 이유로 비권장 — 단일 사용자 개인 도구에 낮은 가치.
  - **행동 감사 로그**: 새 인프라를 만들 필요 없음 — webmanager 자체 stdout/stderr는
    이미 vector 파이프라인이 수집해서 Logs 탭에 노출된다(루트 CLAUDE.md의 vector
    절). 원한다면 뮤테이션 액션(start/stop/remove)마다 `log.Printf` 한 줄만 추가해도
    기존 인프라에 그대로 올라탄다 — 새 저장소/DB 없이 거의 공짜지만, v1 필수는
    아니고 원하면 얹는 정도의 선택 사항.

### 3. 로그 스트리밍: 폴링 재사용 (터미널의 WS 인프라와 결합하지 않음)

**결론**: Supervisor/Logs 탭과 동일한 폴링 패턴을 재사용. 터미널이 새로 들이는
`WS /api/terminal` 인프라에 얹지 않는다.

**근거**:

- 터미널의 WebSocket은 PTY의 raw byte stream(+ 리사이즈 제어 채널)에 맞춰 설계된
  프레이밍이라, 그걸 dind 로그 tailing에 재사용하려면 로그용으로 안 맞는 메시지
  포맷을 억지로 얹거나 별도 분기를 넣어야 한다. dind 쪽 출시 시점을 터미널 구현
  완료 시점에 종속시키는 대가도 생긴다(dind가 먼저 진행되는 우선순위인데 굳이
  뒤 기능에 얹을 이유가 없음).
- `docker logs -f`/`docker events`의 출력은 라인 단위 텍스트(또는 라인당 JSON)라
  이미 있는 폴링 패턴이 그대로 잘 맞는다 — Supervisor 로그 패널이 이미 이 형태를
  다루고 있다.
- 이 저장소가 반복적으로 보여주는 선호(문서화된 "심플함/일관성 우선", 새 UI
  라이브러리도 꼭 필요할 때만 예외로 들이는 태도 — 터미널의 xterm.js 채택 사유
  참고)와도 일치: 스트리밍이 꼭 필요하지 않은 기능에 새 스트리밍 인프라를 앞당겨
  쓰는 것보다, 이미 검증된 폴링을 재사용하는 쪽이 더 이 코드베이스답다.
- 트레이드오프는 명시: 폴링은 실시간 대비 약간의 지연이 있다(하지만 이미 Logs/
  Supervisor 탭 UX가 그렇고, 사용자가 그걸로 불편을 겪었다는 기록도 없어 회귀가
  아님). 진짜 실시간 follow가 필요해지면 터미널의 WS 인프라가 자리잡은 뒤 재검토
  가능하지만, dind v1의 블로커는 아니다. 구현 방식은 짧은 간격으로
  `docker logs --tail N --since <마지막 조회 시각>`을 반복 실행하는 식(지속되는
  follow 서브프로세스를 매달아두지 않음)을 권장 — 폴링 요청마다 새 프로세스를
  짧게 띄우고 끝내는 편이 컨텍스트 취소/좀비 프로세스 관리가 더 단순하다.

## 사용자 확인 필요

- ~~**`docker inspect` 상세 뷰를 v1에 포함할지**~~ — **해결됨(2026-08-03)**:
  저장소 소유자가 "구현하되 비밀번호 게이트로 감싼다"로 결정. `Config.Env`
  평문 노출 우려는 그대로 유효하지만, list/logs와 달리 inspect 하나만
  password-gated 읽기로 두는 것으로 완화 — 아래 "구현 완료: M3" 절 참고.

## 구현 완료 (2026-08-03): M3 (docker inspect 상세 뷰)

바로 위 "사용자 확인 필요" 절의 결정 그대로: `docker inspect` 상세 뷰를
구현하되, `Config.Env` 평문 노출 우려 때문에 list/logs(비밀번호 게이트 없음)와
달리 이것만 기존 공용 비밀번호 게이트(`internal/authgate`)로 감쌌다.

백엔드: `internal/dind/dind.go`에 `Inspect(ctx, id) (json.RawMessage, error)`
추가 — M1/M2와 동일하게 `ValidateID`로 먼저 검증한 뒤, 새 exec 배관을 짜지
않고 기존 `runDocker` 헬퍼(stdout/stderr 분리 + "No such container" →
`ErrNotFound` 변환)를 그대로 재사용(`runDocker(ctx, "inspect", id)`).
`docker inspect <id>`는 단일 ID에도 항상 JSON 배열(원소 1개)을 반환하므로
`[]json.RawMessage`로 언마샬 후 `[0]`만 반환해 HTTP API는 배열이 아니라 단일
객체를 내려준다(빈 슬라이스면 방어적으로 `ErrNotFound` 처리 — `runDocker`가
이미 "No such container"를 잡아내서 평소엔 발생 안 함). `handlers_dind.go`의
`handleInspectDindContainer`는 `handleDindContainerLogs`와 같은 모양(경로
`id` 검증 → `dind.Inspect` 호출 → `writeDindErr`/`writeJSON`). `main.go`에
`GET /api/dind/containers/{id}/inspect`를 `gate.RequirePassword`로 감싸
등록 — list/logs/inspect 중 inspect만 게이트된 이유와, "탭 전체를
`<RequiresUnlock>`으로 감싸지 않고 개별 읽기 라우트 하나만 게이트"하는 전례가
`GET /api/supervisor/processes/{name}/log`(`handleProcessLog`, Supervisor
탭 자체는 `RequiresUnlock` 없음)와 동일 패턴임을 라우트 등록부 주석에 남김.

프론트엔드: 새 `DindInspectPanel.tsx`가 `DindLogPanel.tsx`/`Sheet` 패턴을
거의 그대로 복사 — 마운트 시 `api.get`으로 조회, 헤더에 새로고침 버튼, 에러
배너, JSON 문법 하이라이팅 없이 `<pre>{JSON.stringify(data, null, 2)}</pre>`로
표시(레포 관례, 새 라이브러리 안 들임). `Dind.tsx`에 `logTarget`과 병렬로
`inspectTarget` 상태 + `onInspect` 콜백 추가, `ContainerTable.tsx`의 기존
"로그" 버튼 바로 옆에 "Inspect" 버튼 추가(동일한 `btn btn-secondary
btn-small` 스타일 재사용, 파괴적 동작이 아니라 `window.confirm` 없음).
`App.tsx`는 건드리지 않음(Dind 탭에 `<RequiresUnlock>` 래핑 안 함 — 위
main.go 주석의 전례와 동일하게 라우트 단위 게이트로 충분).

`go build`/`go vet`/`gofmt -l .`, `npm run build`/`npm run lint` 전부
클린 — 실컨테이너(`docker compose up`) 통합 확인은 M1/M2와 마찬가지로 아직
안 함(이 문서가 `qa-request/dind-plan-done.md`로 옮겨진 이유).
