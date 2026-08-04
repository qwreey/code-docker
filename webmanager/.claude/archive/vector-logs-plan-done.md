# vector 도입 + Logs 기능 — 완료

## 업데이트 (2026-08-02, 두 번째 라운드)

- **비밀번호 게이트**: Logs 탭 전체(`/api/logs/*`, 읽기 포함)가 게이트됨 —
  "로그에 시크릿이 노출될 수 있다"는 사용자 판단. 프론트는 `RequiresUnlock`으로
  탭 진입 시점부터 감쌈(다른 부분 게이트 탭과 동일 패턴). 자세히는
  `.claude/archive/authgate-plan-done.md`.
- **UX 개선**: 필터 컨트롤이 스크롤에 안 딸려가던 문제 수정(`.logs-table-wrapper`에
  `max-height`+`overflow-y: auto`, 필터는 그 바깥 고정 영역), 실시간 새로고침
  모드에서 시작/종료 시각 필터 비활성화, 실시간 새로고침이 첫 페이지를 교체하는
  대신 신규 항목을 앞에 누적(기존 2000개 캡 유지) — 백엔드에 "이 시각 이후만"
  커서가 없어서 클라이언트 필터 폴백 사용 중(정확한 서버 커서는 나중 개선 여지,
  `question.md` 참고 안 함 — 사소한 최적화라 급하지 않음).

> 파일명은 `vector-logs`지만 원래 제목은 "vector 도입 계획"이었음 — vector
> 인프라(Dockerfile/supervisord.conf/build.default.sh 변경, 저장소 전체에 영향)와
> webmanager의 Logs 페이지(`/api/logs/*`)가 한 이야기라 합쳐서 관리함. vector
> 인프라 자체는 저장소 전체(root `CLAUDE.md`의 "process model" 절 참고)에 영향을
> 주지만, 존재 이유가 전적으로 webmanager Logs 페이지를 위한 것이라 여기 둠.

`plan.md`의 "로깅: vector 도입 확정" 절에서 나온 결정을 실제로 구현 가능한 수준까지
구체화한 작업 노트. `plan.md`가 작성된 시점 이후 조사해보니 원래 그렸던 설계의 전제
두 가지가 더 이상 맞지 않아서, 이 문서에서 다시 조사하고 설계를 갱신한다.

## 왜 다시 조사가 필요했나 (plan.md 대비 달라진 점)

1. **vector 설치 경로**: plan.md는 "pacman 공식 저장소엔 없어서 AUR(yay) 경유 설치
   필요"라고 적었는데, 지금(2026-08 기준) vector는 **Arch 공식 `extra` 저장소에 있음**
   (`vector 0.57.0-1`, https://archlinux.org/packages/extra/x86_64/vector/). 즉
   `config/build.default.sh`의 기존 `pacman -Suy ...` 한 줄에 `vector`만 추가하면 끝 —
   `yay`/AUR 경로 자체가 필요 없어짐. (repo 전체에 `yay -S` 호출 사례가 아직 하나도
   없다는 것도 확인함 — vector가 그 첫 사례가 될 뻔했으나, 이제 아님)
2. **vector API가 GraphQL이 아님**: plan.md의 `[api]` 설정 초안은 "vector top/tap이
   쓰는 GraphQL API"라고 적었는데, **vector 0.55.0(2026-04)부터 GraphQL API가 완전히
   제거되고 gRPC API로 교체됨** (`/graphql`, playground, WebSocket 구독 전부 삭제,
   `vector.observability.v1.ObservabilityService`로 대체). Arch extra가 배포하는
   0.57.0은 이 변경 이후 버전이라 GraphQL을 절대 못 씀. Go에서 gRPC 클라이언트를 새로
   붙이려면 `.proto` 코드젠이 필요해서 원래 그림보다 구현 비용이 훨씬 커짐. 게다가 이
   API는 인증이 아예 없어서(vector 공식 문서: "must not be exposed to untrusted
   clients") webmanager가 그대로 프록시하는 것도 신중해야 함.
3. **webmanager 쪽 mock이 실제로는 없음**: `webmanager/plan.md`와 `CLAUDE.md`는
   "`/api/logs/*`를 mock으로 먼저 만들어두고 나중에 vector로 교체"라고 적었지만,
   실제 backend(`webmanager/backend`)에는 그 mock이 구현된 적이 없음. 대신
   `GET /api/supervisor/processes/{name}/log`가 supervisord XML-RPC의
   `ReadProcessStdoutLog`/`ReadProcessStderrLog`를 그대로 호출하는 **진짜 동작하는**
   프로세스별 로그 뷰어로 이미 존재함 (`webmanager/backend/handlers_supervisor.go`).
   즉 "서비스별로 로그 조회"라는 원래 목표는 vector 없이 이미 달성돼 있음 —
   vector가 실제로 추가해야 하는 가치를 다시 좁혀야 함.

## vector가 실제로 채워야 할 공백

기존 supervisord RPC 뷰어가 이미 하는 것: 프로세스 하나 골라서 최근 로그 보기(polling
방식, 스트리밍 아님). vector 없이도 충분.

vector 없이는 안 되는 것(이번 도입의 진짜 목적):
- **로그 파일 로테이션**: 지금 모든 `[program:X]`는 `stdout_logfile=/dev/fd/1`,
  `maxbytes=0`(무제한)로 컨테이너 stdout에 직접 씀 — 파일로 안 남고 docker 로그
  드라이버에만 의존, 별도 보존/회전 정책이 없음
- **여러 서비스 로그를 시간순으로 섞어서(interleaved) 검색**: 지금은 프로세스 하나씩만
  볼 수 있음, "전체 로그에서 에러 문자열 grep" 같은 건 불가능
- **`docker compose logs`가 프로그램별로 라벨링되지 않은 채 다 섞여 나옴** — vector가
  파일마다 `app_name`을 붙여서 다시 stdout으로 흘려주면 오히려 지금보다 나아짐

## 설계 결정 (원래 초안 대비 단순화)

**vector의 `[api]`(gRPC)는 이번 범위에서 켜지 않는다.** 대신:

1. 모든 `[program:X]`의 `stdout_logfile`을 `/var/log/X/stdout.log`
   (`stdout_logfile_maxbytes=10MB`, `stdout_logfile_backups=3`)로 바꿔서 실제 파일로
   남긴다 — supervisord 자체 로테이션 사용, 외부 logrotate 불필요
2. **`webmanager/backend`의 기존 로그 API는 코드 변경이 필요 없다** — supervisord의
   `ReadProcessStdoutLog`는 `stdout_logfile`이 가리키는 파일을 읽는 것뿐이라
   `/dev/fd/1`이든 실제 파일이든 동일하게 동작함(오히려 이제 진짜 회전이 걸려서 더
   안전해짐). 이번 라운드는 순수 인프라(Dockerfile/build/supervisord.conf) 작업이고
   webmanager Go/React 코드는 안 건드림
3. vector는 이 파일들을 `file` source로 tail → `remap`으로 파일 경로에서 `app_name`
   추출 → **`console` sink로 다시 stdout에 라벨링된 형태로 흘려보냄** — 이게
   `docker compose logs`가 프로그램 구분 없이 다 섞여 나오던 문제를 해결하면서, 기존
   가시성을 잃지 않게 하는 방법
4. gRPC API/tap, "webmanager에서 전체 로그 검색" UI는 이번 범위에서 하지 않고 TODO로
   남긴다 (아래 "이번에 안 하는 것" 참고) — 필요해지면 그때 gRPC 클라이언트 코드젠
   비용을 다시 따져서 붙인다

## 조사한 vector 세부사항 (설계 근거)

- **file source**: `include`에 glob 지원(`/var/log/*/stdout.log*`), 기본적으로 파일
  내용 체크섬으로 파일을 식별(inode 아님) → supervisord가 로그를 회전(`.log` →
  `.log.1`로 밀어내고 새 `.log` 생성)해도 안전하게 추적됨. 자동으로 붙는 필드:
  `file`(절대경로), `host`, `message`, `source_type`. `data_dir`로 체크포인트(어디까지
  읽었는지) 저장 위치 지정 가능 — 컨테이너 재생성에도 살아남게 하려면 바인드 마운트되는
  `/code/.vector/state` 밑에 둬야 함(다른 서비스들의 `/code/.<service>/state` 관례와
  동일)
- **remap transform (VRL)**: plan.md 초안의 `split!(.file, "/")` 로 경로에서 앱 이름
  뽑는 방식 그대로 유효함
- **console sink**: 표준 stdout으로 다시 씀 — `encoding.codec`을 `text`로 하고
  템플릿(`"[{{ app_name }}] {{ message }}"`) 사용하면 라벨링된 형태로
  `docker compose logs`에 나옴
- **`[api]`를 켜지 않으므로** 포트 노출/인증 문제 자체가 이번 범위에 없음. 나중에 켜게
  되면 `127.0.0.1:8686`로 바인드하고 `docker-compose.yml`에는 포트 매핑을 추가하지
  않는 것(= `tailscaled`의 SOCKS5 `localhost:1055`와 동일한 "컨테이너 내부에서만 접근"
  기존 관례)이 맞음
- **리소스**: Rust로 작성돼 있어 이 정도 규모(로컬 파일 몇 개 tail)의 워크로드에서는
  가볍다는 게 공식 문서/커뮤니티 확인 결과지만, 정확한 유휴 메모리 수치는 벤치마크
  문서에 없음 — 필요하면 배포 후 `docker stats`로 직접 확인

## 구현 계획

기존 override 패턴(root `CLAUDE.md`) 그대로 따름.

1. **`config/build.default.sh`**: 기존 `pacman -Suy ...` 목록에 `vector` 추가 (AUR/yay
   불필요)
2. **`Dockerfile`**: main 스테이지에 로그 디렉토리 생성 추가
   ```dockerfile
   RUN mkdir -p /var/log/code-server /var/log/sshd /var/log/tailscaled \
       /var/log/tailscale-forward /var/log/tailscale-status /var/log/webmanager \
       /var/log/vector
   ```
   `COPY --chown=root:root config script/... /etc/code-docker/` 라인에
   `script/vector-service.sh` 추가
3. **`config/supervisord.default.conf`**: 기존 6개 `[program:X]` 블록의
   `stdout_logfile=/dev/fd/1` → `/var/log/X/stdout.log` 로 전부 변경, `maxbytes=0` →
   `10MB`, `stdout_logfile_backups=3` 추가 (stderr도 동일하게). 새 `[program:vector]`
   블록 추가:
   ```ini
   [program:vector]
   command=/etc/code-docker/vector-service.sh
   stdout_logfile=/dev/fd/1
   stdout_logfile_maxbytes=0
   stderr_logfile=/dev/fd/2
   stderr_logfile_maxbytes=0
   ```
   (vector 자신은 콘솔로 직접 나가는 게 목적이므로 파일로 돌리지 않음 — 회전 대상에서
   제외)
4. **`script/vector-service.sh`** (신규, 기존 디스패처 패턴 그대로):
   ```bash
   #!/bin/bash
   set -e

   if [ -e /etc/code-docker/vector-service.override.sh ]; then
       exec /etc/code-docker/vector-service.override.sh
   else
       exec /etc/code-docker/vector-service.default.sh
   fi
   ```
5. **`config/vector-service.default.sh`** (신규): override 설정 파일 선택 후 실행 —
   `config/tailscale-service.default.sh`처럼 상태 디렉토리를 `/code` 밑에 준비
   ```bash
   #!/bin/bash
   set -e

   mkdir -p /code/.vector/state

   vector_config=/etc/code-docker/vector.default.toml
   if [ -e /etc/code-docker/vector.override.toml ]; then
       vector_config=/etc/code-docker/vector.override.toml
   fi

   exec /usr/bin/vector --config "$vector_config"
   ```
6. **`config/vector.default.toml`** (신규):
   ```toml
   data_dir = "/code/.vector/state"

   [sources.app_logs]
   type = "file"
   include = ["/var/log/*/stdout.log*"]

   [transforms.tag_app_name]
   type = "remap"
   inputs = ["app_logs"]
   source = '''
   path_parts = split!(.file, "/")
   .app_name = path_parts[2]
   '''

   [sinks.console]
   type = "console"
   inputs = ["tag_app_name"]
   target = "stdout"
   encoding.codec = "text"
   encoding.only_fields = []
   ```
   (`encoding`의 정확한 템플릿 문법은 구현 시 vector 버전 문서로 재확인 — 목표는
   `[app_name] message` 형태 출력)
7. **`.gitignore`**: 기존 `config/*.override*` 패턴이 이미 `vector*.override.*`도
   커버하므로 추가 변경 불필요 (확인 완료)
8. **`docker-compose.yml`**: 변경 없음 — vector API를 이번 범위에서 켜지 않으므로 포트
   추가 불필요
9. **`README.md`**: "override 커스터마이징" 목록에 `vector-service.*.sh`,
   `vector.*.toml` 항목 추가 (다른 override 대상들과 같은 스타일로)

## 검증 방법

1. `docker compose build code-docker` 성공 확인
2. `docker compose up -d` 후 `docker compose ps`로 컨테이너 기동 확인
3. `docker compose exec code-docker supervisorctl status` 로 `vector` program이
   RUNNING인지 확인
4. `docker compose logs -f code-docker` 로 vector가 각 프로그램 로그를
   `[app_name] ...` 형태로 라벨링해서 흘려보내는지 눈으로 확인 (예: code-server 재시작
   시 `[code-server] ...` 로그가 뜨는지)
5. 컨테이너 안에서 `ls -la /var/log/code-server/` 등으로 실제 파일이 생기고 있는지,
   그리고 파일이 10MB를 넘겼을 때 `.log.1`로 회전되는지 확인 (로그가 많은
   `code-server` 등으로 부하를 걸어 확인하거나, 시간 절약을 위해
   `stdout_logfile_maxbytes`를 임시로 아주 작게 낮춰서 회전 트리거를 확인 후 원복)
6. webmanager UI에서 기존 프로세스별 로그 보기가 여전히 정상 동작하는지 확인 (코드
   변경이 없다는 가정을 실제로 검증하는 단계 — 여기서 깨지면 5번 항목의 가정이 틀린
   것이므로 재조사 필요)

## 이번에 안 하는 것 (TODO로 남김)

- vector `[api]`(gRPC) 활성화 및 webmanager 백엔드에서의 프록시/래핑 — GraphQL이 아닌
  gRPC라서 Go 쪽에 `.proto` 코드젠이 필요해 비용이 커짐. "여러 서비스 로그를 한 화면에
  검색"이 실제로 필요해지는 시점에 다시 설계
- webmanager에 "전체 로그 통합 검색" UI/API 추가 — 위 항목에 의존
- `webmanager/CLAUDE.md`/`plan.md`의 "mock `/api/logs/*` 계약" 관련 서술 정정 —
  실제로는 mock이 구현된 적이 없고 supervisord RPC 기반 실제 엔드포인트만 있다는 점을
  나중에 문서에 반영 필요 (이번 작업 범위 밖, 별도로 처리)
- vector 콘솔 sink의 정확한 출력 포맷(문자열 템플릿 문법)은 초안 수준 — 실제 구현
  시점의 vector 0.57.x 문서로 `encoding` 옵션 재확인 필요

## 구현 완료 (2026-08-02)

이 문서의 설계대로 구현 완료. `config/build.default.sh`, `Dockerfile`,
`config/supervisord.default.conf`, `script/vector-service.sh`(신규),
`config/vector-service.default.sh`(신규), `config/vector.default.toml`(신규),
`README.md` 전부 반영. 실제 vector 0.57.0 바이너리(Arch `extra` 패키지와 동일 버전)를
로컬에 받아 `vector validate --config-toml`과 실제 실행(합성 로그 파일 tail)으로 검증함 —
`docker compose build`/`up` 을 통한 실컨테이너 검증은 아직 못 함(다른 에이전트가 같은
컨테이너를 병행 작업 중이라 이번 라운드 범위 밖).

**원래 초안 대비 실제로 달랐던 부분** (검증 과정에서 발견):

1. **`split!(.file, "/")[2]` 는 틀린 인덱스였음.** `/var/log/code-server/stdout.log` 를
   `/` 로 split 하면 첫 요소가 빈 문자열이라 `["", "var", "log", "code-server",
   "stdout.log"]` 가 되고, `app_name` 은 인덱스 `[2]`("log")가 아니라 `[3]`
   ("code-server")임. 최종 구현은 고정 인덱스 대신 `path_parts[-2]`(뒤에서 두 번째
   요소)를 사용 — 로테이션 접미사(`stdout.log.1` 등)나 절대/상대 경로 여부와 무관하게
   항상 올바른 디렉토리명을 가리키도록 함
2. **VRL 초안 문법이 실제로는 컴파일 에러였음.** `downcase(.message)`와
   `"[" + .app_name + "] " + .message` 둘 다 "unhandled fallible assignment"
   (E103)로 검증 실패 — `.message`/`.app_name` 의 정적 타입이 `any`라서. `downcase!()`,
   `string!()` 로 감싸 infallible로 만들어 해결
3. **console sink의 `encoding.codec = "text"` 는 템플릿 문법이 없음** — `message`
   필드를 그대로 찍을 뿐이라, `[app_name] message` 라벨을 넣으려면 sink 앞에 별도
   remap transform(`format_console`)에서 `.message` 자체를 덮어써야 함. 이 transform은
   `tag_level` 뒤에 별도로 분리해서 붙였음 — `webmanager_logs` sink는 원본
   `.message`(라벨 안 붙은)를 그대로 받아야 하기 때문
4. `data_dir`는 top-level 전역 키가 맞음(확인됨), `vector --config <path>`(파일 포맷은
   확장자로 자동 감지)도 초안 그대로 유효, file sink의 `path`가 strftime 스타일
   템플릿(`%Y-%m-%d`)을 지원하는 것도 확인됨(`vector generate` 기본 예시가 이미 이
   문법을 씀)

**신규 추가: `webmanager_logs` sink (이 초안에는 없던 것).** webmanager의 Logs 페이지가
vector의 gRPC API 없이도 실데이터를 보여줄 수 있도록, `console` sink와 별도로 `file`
타입 sink를 하나 더 붙임 — `tag_level` transform 출력을 그대로 받아
`/code/.vector/logs/%Y-%m-%d.jsonl` 에 하루 단위로 JSON 한 줄씩 기록. `encoding.codec =
"json"` + `encoding.only_fields = ["timestamp", "app_name", "level", "message"]` 로
필드를 정확히 4개(`timestamp`/`app_name`/`level`/`message`)로 제한 — `only_fields` 없이
돌려보면 vector가 자동으로 붙이는 `file`/`host`/`source_type` 필드까지 새서 계약이
깨지므로, 실제로 이 옵션이 필터링을 하는지도 직접 실행해서 확인함. `level`은
`error`/`warn`/`info` 중 하나(문자열 부분일치 휴리스틱, 정밀 파싱 아님).

실행 검증 예시(합성 로그로 실제 vector를 돌려서 얻은 출력, 그대로):
```json
{"app_name":"code-server","level":"info","message":"starting up normally","timestamp":"2026-08-02T09:17:20.279175718Z"}
{"app_name":"tailscaled","level":"error","message":"ERROR: could not bind port","timestamp":"2026-08-02T09:17:20.279203210Z"}
```

**작지만 유의미한 범위 결정**: 6개 program 모두 `stderr_logfile` 도 실제 파일로 회전시켰지만
(파일명 `stderr.log`), vector의 `include` glob은 이 초안 그대로 `stdout.log*` 만
tail함 — stderr는 vector/webmanager 구조화 로그에는 안 실리고, webmanager의 기존
`ReadProcessStderrLog` RPC로만 직접 조회 가능(이건 vector 도입 이전부터 있던 별도
경로라 문제 없음). 필요해지면 나중에 `include` 에 `stderr.log*` 를 추가하고
`app_name`/`level` 로직은 그대로 재사용하면 됨.

**아직 검증 못 한 것 (다음 라운드 TODO)**: 실제 컨테이너에서의
`docker compose build && up` 전체 통합 확인, supervisord 로그 회전이 실제로 10MB에서
트리거되는지, webmanager 백엔드가 이 JSONL 계약대로 실제로 파싱해서 보여주는지(그쪽은
별도 에이전트가 병행 작업 중).

## 이후 업데이트 (`.claude/archive/webmanager-review.md` (레포 루트) 라운드에서 실제 컨테이너 검증 + 버그 수정)

- **실제 `docker compose build && up`으로 전체 통합 확인 완료**: 7개 supervisord
  program 전부 RUNNING, `docker compose logs`가 `[app_name] ...` 형태로 라벨링,
  `/code/.vector/logs/*.jsonl` 정상 생성, webmanager `/api/logs/entries`가 실제
  데이터 반환(`mock: false`) — 전부 확인됨.
- **회귀 발견 및 수정**: vector가 stdout만 tail하도록 만들어져 있었는데,
  `tailscaled`는 로그인 URL을 포함한 진단 메시지를 전부 stderr로만 써서
  `docker compose logs`에서 로그인 URL이 완전히 사라져 있었음(README가 안내하는
  워크플로우가 깨짐). `config/vector.default.toml`의 `sources.app_logs.include`에
  `/var/log/*/stderr.log*`도 추가해서 해결, 실제 컨테이너에서 로그인 URL이 다시
  뜨는 것 확인.
- **`internal/logstore` 오버사이즈 라인 버그 수정**: 로그 한 줄이 1MB 넘으면
  `bufio.Scanner`가 에러를 내는데 이걸 그대로 전파해서 그날치 로그 전체가 502가
  났음 — 스캔 에러를 fatal로 취급하지 않고 에러 이전까지 스캔된 엔트리는 반환하도록
  수정.
- **타임존 자정 경계 버그 수정**: 백엔드가 `time.Now()`(로컬)로 날짜 파일명을
  계산하는데 vector의 파일 경로 템플릿은 UTC 기준이라, `TZ`를 설정하면 자정 근처
  로그가 누락될 수 있었음 — 양쪽 다 UTC로 통일.
- 자세한 내용은 `.claude/archive/webmanager-review.md` (레포 루트) 참고.
