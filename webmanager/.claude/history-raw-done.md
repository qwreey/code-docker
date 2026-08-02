# webmanager 설계 히스토리 (아카이브)

`webmanager/plan.md`에서 분리한 전체 의사결정 로그. 각 라운드에서 "왜 이렇게 정했는지"의
전체 논증 과정이 궁금할 때만 열어보면 되는 문서 — 현재 상태/남은 TODO는
`webmanager/plan.md`(간결하게 유지됨)를 보면 됨. 아래는 작성 당시 시점의 기록이라 이후
라운드에서 뒤집힌 판단(예: vector 도입 여부)도 그대로 남아있음 — 최종 결론은 각 절 안에
표시되어 있거나 `webmanager/plan.md`를 신뢰할 것.

## 관리 대상 컴포넌트별 현황 (기존 메커니즘 조사 결과, 최초 라운드)

### tailscale (forward 포함)
- 상태: `tailscale status --json` (device 목록, BackendState, IP 등)
- 로그인/로그아웃: `tailscale up`/`tailscale logout`, 로그인 URL은 인터랙티브 stdout에만 찍힘
  → 웹에서 트리거하려면 `tailscale up` 실행 후 auth URL을 파싱해서 보여줘야 함
- `forwards`/`publish`: `/code/.tailscale/config.yaml` 이 단일 진실 소스 (yq로 읽고 씀).
  편집 후 `forward-reload` (`supervisorctl restart tailscale-forward`)로 반영
  — 로그인 세션(`tailscaled`)은 안 건드림
- `TAILSCALE_LOGIN_SERVER`/`TAILSCALE_ENABLED`는 docker-compose 환경변수라서 컨테이너
  안에서는 못 바꿈 (읽기 전용으로 보여주기만 가능)

### mise
- `code-runner.default.sh`에서 `mise env --shell bash`로 code-server 프로세스에 주입.
  즉 mise는 `$HOME/.local/bin/mise` (유저 스코프), 전역 시스템 패키지가 아님
- 관리 후보: 설치된 tool/version 목록(`mise ls`), 전역 config(`~/.config/mise/config.toml`
  또는 `.mise.toml`), `mise use -g <tool>@<version>` 실행
- 여기 손대면 code-server 재시작(`restart`)까지 필요할 수 있음 (PATH 갱신)

### supervisord
- 이미 `/run/supervisor.sock` 에 XML-RPC 인터페이스가 떠있음 (supervisord.default.conf) —
  프로그램 목록/상태 조회, start/stop/restart를 소켓으로 직접 호출 가능. 가장 구현이 쉬운 부분
- 로그: 각 program이 stdout/stderr를 `/dev/fd/1,2`로 흘려서 컨테이너 로그에만 남음 —
  webmanager에서 프로그램별 로그를 보려면 별도 로그 파일로 바꾸거나 `docker logs`를 파싱해야 함
  (전자가 더 간단 — supervisord.conf의 program별 stdout_logfile을 파일로 바꾸는 옵션 검토)

### dind 컨테이너
- `DOCKER_HOST=tcp://dind:2375` 로 이미 평문 TCP 도달 가능 (인증/TLS 없음, code-docker-internal
  전용). Docker Engine API를 그대로 웹 UI 백엔드에서 호출하면 됨 (컨테이너/이미지 목록,
  시작/정지/삭제, 로그 스트림) — 새 인증 계층 추가할 필요 없이 기존 신뢰 경계 재사용
- 주의: 이 API는 사실상 호스트 루트 권한과 동급이라, webmanager 자체의 인증이 곧 이 API의
  유일한 문지기가 됨 (README의 기존 보안 각주 참고)

### ssh authorized_keys
- 현재 `/etc/ssh` 전체가 `./sshd:/etc/ssh`로 바인드 마운트, `authorized_keys` 파일 위치는
  sshd_config 확인 필요 (기본 `~/.ssh/authorized_keys` 또는 AuthorizedKeysFile 지시자) — 아직
  이 레포에 authorized_keys 관리 로직이 없음, 새로 만들어야 함
- 관리 후보: 키 목록 보기/추가/삭제, 각 키에 comment/fingerprint 표시

### git 크리덴셜/설정
- 레포에 아직 아무 메커니즘 없음 (완전히 새로 설계)
- 후보: `~/.gitconfig` (user.name/email, 등) 편집, credential.helper 설정, SSH용 git 호스트별
  키 관리 (`~/.ssh/config` + 키 파일), 또는 `gh auth login` 연동 여부

### 웹쉘 (터미널)
- xterm.js(프론트) + PTY(백엔드)로 여는 표준 패턴 (ttyd/gotty/wetty와 동일 계열).
  code-server가 이미 통합 터미널을 제공하긴 하지만, webmanager 단독으로도 열리면 code-server
  없이도 최소한의 접근 수단이 됨 (예: code-server 자체가 죽었을 때 복구용)

## 확정된 아키텍처 결정 (1차 질문)

1. **배포 형태**: 기존 이미지에 새 supervisord program으로 추가 (`webmanager.default.sh`,
   override 패턴 그대로 재사용). 별도 컨테이너로 분리하지 않음 — supervisord unix socket,
   dind TCP 모두 같은 컨테이너 안에서는 별도 마운트/네트워크 작업 없이 바로 접근 가능
2. **기술 스택**: Go 단일 바이너리, `go:embed`로 프론트 자산까지 포함. 런타임 의존성 없음
   → `build.default.sh`에 go 컴파일러만 빌드 스테이지에 추가(또는 멀티스테이지 빌드로
   컨테이너에는 컴파일러 자체도 안 남기는 방향 검토). PTY는 `creack/pty` 사용
3. **인증**: 리버스 프록시의 forward-auth에만 의존 (code-server와 동일한 신뢰 모델 재사용).
   **주의**: dind Docker API 수준 권한(사실상 호스트 루트급)을 다루므로, 이 결정은 곧
   "프록시 앞단 인증이 뚫리면 webmanager를 거쳐 컨테이너 탈출까지 간다"는 뜻 — README의
   기존 dind 보안 각주와 동일한 성격의 트레이드오프로 문서화 필요. self-login 계층을 넣지
   않는 대신, **네트워크 노출 범위를 최소화하는 게 필수적**이 됨

(주: 실제 구현에서는 go:embed 대신 런타임에 정적 파일을 디렉토리에서 서빙하는 방식으로
단순화됨 — frontend `dist`를 빌드 스테이지에서 이미지에 COPY하고 `WEBMANAGER_STATIC_DIR`
환경변수로 그 경로를 가리키게 함. go:embed는 프론트 변경마다 백엔드 재컴파일이 필요해져서
빌드 파이프라인이 더 간단한 쪽을 택함.)

## 추가 확정 사항 (2차 질문 답변)

4. **바인드 주소**: 일단 미정 상태로 두고 구현 진행. 지금은 그냥 `0.0.0.0:81`로 띄운다
   (호스트 포트로 열든 안 열든 나중에 정함). 사용자가 향후 code-server(vscode) 쪽 코드를
   패치해서 80번 포트 요청을 path 단위로 갈라 webmanager로 라우팅하는 방식도 검토 중 —
   이 경우 리버스 프록시 네트워크 위치와 무관하게 code-server의 forward-auth를 그대로
   물려받게 됨. 지금 단계에서 바인드 보안은 구현을 막는 조건이 아님
5. **MVP 순서**: 우선순위 없이 6개 컴포넌트를 대략 동시에 설계하고 구현도 병행
6. **프론트엔드**: Vite + React(CSR). 확장성/컴포넌트화를 중시 — 컴포넌트 6개가 각자
   탭/패널로 늘어나도 무리 없게 구성. 빌드는 별도 `FROM` 빌드 스테이지(Node/Bun 등)에서
   `dist`를 만들고, 최종 이미지에는 Go 바이너리가 `dist`를 embed(또는 단순 정적 서빙)하는
   구조 — 기존 Dockerfile의 `docker:latest --from=docker-bin` 멀티스테이지 패턴과 동일한 결

## 잠정 리포지토리 구조 (최초 초안)

```
webmanager/
  plan.md
  backend/                 # Go 모듈, go:embed로 frontend/dist 포함
    main.go
    internal/
      supervisor/          # /run/supervisor.sock XML-RPC 클라이언트
      dind/                # tcp://dind:2375 Docker Engine API 클라이언트
      tailscale/           # `tailscale` CLI 래핑 + config.yaml r/w
      mise/                # `mise` CLI 래핑 + config 파일 r/w
      sshkeys/              # authorized_keys 파싱/쓰기
      gitconfig/            # ~/.gitconfig, credential, ~/.ssh/config 관리
      termshell/            # creack/pty 기반 웹쉘 세션
    go.mod
  frontend/                # Vite + React (CSR), 컴포넌트별 탭/패널
    src/
      components/
        Supervisord/
        Dind/
        Tailscale/
        Mise/
        SshKeys/
        GitConfig/
        Terminal/
    package.json
    vite.config.ts
```

(실제 구현은 대체로 이 구조를 따랐으나 `internal/dind`, `internal/mise`, `internal/termshell`,
`Supervisord/`, `Dind/`, `Mise/`, `Terminal/` 프론트 폴더는 해당 컴포넌트가 아직 구현되지
않아 존재하지 않음. `internal/tailscale`은 CLI 래핑이 아니라 `config.yaml` 직접 r/w로,
`internal/procinfo`/`internal/logstore`/`internal/cgroup` 등 원래 계획에 없던 패키지가
나중 라운드에서 추가됨.)

빌드/배포는 기존 override 패턴을 그대로 따름:
- `config/webmanager.default.sh` (+ `.override.sh`) → `script/webmanager.sh` 디스패처
- `supervisord.default.conf`에 `[program:webmanager]` 추가
- `Dockerfile`에 프론트 빌드 스테이지(`FROM node:... AS webmanager-frontend`) +
  백엔드 빌드 스테이지(`FROM golang:... AS webmanager-backend`, frontend dist를 COPY 후
  go:embed) 추가, 최종 스테이지엔 컴파일된 바이너리만 COPY
- `docker-compose.yml`에 `81:81` 같은 포트 매핑 추가 (바인드 주소 문제는 미정이므로 지금은
  단순히 열어둠)

## 컴포넌트별 API 표면 (초안, 구현 전 상상)

- **supervisord**: `GET /api/supervisor/processes`, `POST /api/supervisor/processes/:name/restart`
  (start/stop 포함), `GET /api/supervisor/processes/:name/log` (스트림) — 단, 지금은 각 program이
  stdout/stderr를 `/dev/fd/1,2`로만 흘리므로 프로그램별 로그를 보려면 supervisord.conf의
  stdout_logfile을 실제 파일 경로로 바꾸는 선행 작업 필요 (컨테이너 통합 로그는 유지하고
  싶다면 `tee` 또는 파일+stdout 이중 기록 방식 검토)
- **dind**: `GET /api/dind/containers`, `GET /api/dind/images`, `POST /api/dind/containers/:id/start|stop|remove`,
  `GET /api/dind/containers/:id/logs` (스트림) — Docker Engine API를 얇게 프록시/래핑
- **tailscale**: `GET /api/tailscale/status` (`tailscale status --json` 파싱), `POST /api/tailscale/login`
  (`tailscale up` 실행 후 auth URL 파싱해서 반환), `POST /api/tailscale/logout`,
  `GET/PUT /api/tailscale/config` (`/code/.tailscale/config.yaml` r/w, 저장 시 `forward-reload`
  자동 트리거)
- **mise**: `GET /api/mise/tools` (`mise ls --json`), `POST /api/mise/tools` (`mise use -g x@y`),
  `DELETE /api/mise/tools/:tool/:version`, 반영 후 code-server 재시작 필요 여부 UI에 안내
  (`restart` 트리거 버튼 포함 검토)
- **ssh keys**: `GET/PUT /api/ssh/authorized-keys` — `AuthorizedKeysFile` 지시자가
  `.ssh/authorized_keys` (상대경로, sshd_config:42)로 되어있어 실제 파일은 로그인 유저의
  홈 기준 — 컨테이너 유저가 root/HOME=/code인 것으로 보여 `/code/.ssh/authorized_keys`로
  추정됨(아직 파일 없음, 구현 시 확인 필요). 키 목록/추가/삭제 + fingerprint 표시
- **git config**: `GET/PUT /api/git/config` (`~/.gitconfig` 파싱/쓰기: user.name/email,
  credential.helper 등), `GET/PUT /api/git/ssh-config` (`~/.ssh/config` + 호스트별 키 관리) —
  credential 저장 방식(평문 store vs 다른 helper)은 구현 시 별도 논의 필요
- **웹쉘**: `WS /api/terminal` — creack/pty로 새 쉘 세션 생성, xterm.js와 WebSocket으로 연결

(실제로 구현된 정확한 엔드포인트/응답 형태는 `webmanager/backend/README.md`가 최종
소스 — 위 목록은 구현 전 초안이라 세부적으로 다름.)

## 로깅: vector 도입 첫 검토 (3차 질문 답변, 이후 뒤집힘 — 아래 "MVP 범위" 절 참고)

서비스가 늘어날수록 `docker compose logs` 통합 로그만으로는 디버깅이 힘들어지므로,
프로그램별 로그 파일 + [vector](https://vector.dev)로 journald 비슷하게 서비스별 조회를
제공하기로 함.

- **supervisord.conf 변경**: 각 `[program:X]`의 `stdout_logfile`을 `/var/log/X/stdout.log`로
  변경 (X = 프로그램 이름, 프로그램마다 다른 디렉토리). 파일 비대화 방지를 위해
  `stdout_logfile_maxbytes=10MB`, `stdout_logfile_backups=3` 유지.
- **vector 설정 초안** (`config/vector.default.toml`):
  ```toml
  data_dir = "/var/lib/vector"

  [sources.all_apps]
  type = "file"
  include = ["/var/log/*/stdout.log*"]

  [transforms.extract_app_name]
  type = "remap"
  inputs = ["all_apps"]
  source = '''
  path_parts = split!(.file, "/")
  .app_name = path_parts[2]
  '''

  [api]
  enabled = true
  address = "127.0.0.1:8686"
  ```
  `[api]`는 vector top/tap이 쓰는 GraphQL API로 상상했으나, **실제로는 이미 vector
  0.55.0(2026-04)에서 GraphQL이 제거되고 gRPC로 교체된 뒤였음** — 이 사실은 다른 에이전트가
  `vector-logs-plan-done.md`에서 재조사해서 바로잡음. 최종 구현은 gRPC API를
  아예 켜지 않고, 대신 vector의 file sink로 JSONL을 직접 써서 webmanager가 읽는 방식으로
  단순화됨.
- **설치(오판)**: "vector는 pacman 공식 저장소엔 없어서 AUR(yay) 경유 설치 필요"라고 적었으나,
  실제로는 Arch `extra` 공식 저장소에 있어서 AUR이 전혀 필요 없었음 (마찬가지로
  `vector-logs-plan-done.md`에서 재확인).
- **webmanager API 초안**: `GET /api/logs/apps`, `GET /api/logs/:app/stream` (vector API를
  통한 tail/follow) — 이 형태 대신 최종적으로는 `GET /api/logs/apps`/`GET /api/logs/entries`
  (JSONL 폴링 방식)로 구현됨, `webmanager/backend/README.md` 참고.

## ssh authorized_keys 경로 확정

컨테이너 직접 확인 결과:
- `HOME=/code`, 실행 유저는 `root` (uid=0) — Dockerfile에 별도 `USER`/`useradd` 없음
- `sshd_config`의 `AuthorizedKeysFile	.ssh/authorized_keys` (상대경로) → 실제 경로는
  **`/code/.ssh/authorized_keys`**
- 아직 `/code/.ssh` 디렉토리 자체가 없음 — webmanager가 최초 키 추가 시 `mkdir -p -m 700
  /code/.ssh` 하고 파일은 `-m 600`으로 생성해야 함 (sshd가 권한 검사함, 디렉토리/파일이
  group/other에 쓰기 권한 있으면 로그인 거부)

## git 크리덴셜: 두 방식 모두 지원

- **SSH 키 방식**: `~/.ssh/config`에 호스트별 `IdentityFile` 지정 + 키 파일 자체를
  webmanager가 생성/업로드/삭제 관리. 새 키 생성 시 공개키를 보여줘서 GitHub/GitLab에
  등록하도록 안내하는 흐름 필요
- **HTTPS + credential store 방식**: `~/.gitconfig`에 `[credential] helper = store` 설정,
  `~/.git-credentials`에 `https://user:token@host` 형식으로 평문 저장. 평문 저장이라는 점을
  UI에 명시(경고 문구) — 파일 권한은 `600`으로 강제
- UI에서 레포/호스트별로 두 방식 중 선택해서 추가하는 구조로 설계 (라디오 버튼: SSH 키 /
  HTTPS 토큰)

## MVP 구현 범위 확정 (4차 결정)

**처음 구현한 것**: supervisord 관리, ssh authorized_keys 관리, git 설정(gitconfig +
ssh 호스트별 키 + HTTPS credential store) — 기존 인프라 재사용이 쉽거나(supervisord) 단순
파일 관리로 끝나는(ssh keys, git) 컴포넌트들부터

**처음엔 미룬 것 (이후 라운드에서 대부분 완료됨 — 최신 상태는 webmanager/plan.md 참고)**:
- tailscale 관리 (로그인 플로우 UX는 계속 범위 밖, config.yaml CRUD는 완료)
- mise 관리 (계속 최후순위)
- dind 관리 (계속 미착수)
- 웹쉘 (계속 미착수)

vector 기반 통합 로깅도 처음엔 "supervisord XML-RPC가 이미 로그 조회를 지원하니 필요
없다"고 판단해 보류했으나, 실제 컨테이너에서 확인해보니 `stdout_logfile=/dev/fd/1`이라
RPC 자체가 실패하는 걸 나중에 발견함 (아래 참고) — 이 오판이 vector 재도입의 계기가 됨.

## 2차 구현 라운드 (5차 결정)

이 컨테이너는 테스트용이라 실제 뮤테이션(키 추가/삭제 등)을 자유롭게 테스트해도 됨.
다만 다른 에이전트가 같은 컨테이너로 QoL 작업을 병행 중이었어서, 이 라운드에서는
`docker compose build`/`up`/`restart` 등 컨테이너 실행에 관여하지 않고 로컬 빌드/lint로만
검증함.

이 라운드에서 추가된 것: tailscale forwards/publish 설정 CRUD(로그인 플로우는 범위 밖),
git 커밋 사이닝(SSH/GPG) + 최소 GPG 키 관리, 로그 뷰어(처음엔 mock 데이터로 시작 —
`mock: true` 플래그로 프론트에 표시, 나중에 vector 연동 시 백엔드만 교체할 수 있게 계약
고정).

**중요 발견**: `GET /api/supervisor/processes/{name}/log`를 실제 컨테이너에 curl로
호출해보니 모든 프로세스에서 `{"error":"FAILED"}` 반환됨 — 모든 program이
`stdout_logfile=/dev/fd/1`(seek 불가능한 파이프)로 설정돼있어서 supervisord의
`readProcessStdoutLog` RPC 자체가 이 경로에 대해 동작하지 않았기 때문. 즉 첫 라운드에서
"이미 동작한다"고 가정했던 로그 패널은 실제 컨테이너에서는 100% 실패 상태였음 — vector
도입 여부와 무관하게 `stdout_logfile`을 실제 파일로 바꾸는 수정이 필요하다는 게 이때
확정됨.

## vector 도입 여부 재논의 (결론: 도입)

한 시점에 "gRPC API를 안 켤 거면 vector가 하는 일은 결국 파일 tail + 라벨 재출력뿐이니
`tail -F | sed` 스크립트로도 되는 거 아니냐"는 의견이 나왔었으나, 재검토 후 철회됨. 이유:

- 로테이션으로 로그가 여러 조각(`.log.1`, `.log.2`...)으로 쪼개지는 것과, 나중에 새
  프로그램이 추가돼 로그 디렉토리가 새로 생기는 것까지 자동으로 계속 추적하는 건
  vector의 `file` source가 기본 제공하는 기능 — 직접 스크립트로 하면 결국 주기적
  재스캔/체크포인트 로직을 부실하게 재구현하게 됨 (바퀴 재발명)
- 멀티라인 로그, 재시작 후 이어읽기(체크포인트) 등도 마찬가지로 vector가 이미 해결한 문제
- vector 프로그램 하나만 콘솔 싱크로 자신의 stdout에 라벨링된 로그를 내보내고 나머지
  프로그램은 실제 파일에만 쓰는 구조가 "vector-viewer 하나만 fd1으로 나가는 패턴"이라
  원하는 방향과 일치함

최종 설계와 구현 검증 결과는 `vector-logs-plan-done.md` 참고 (실제
vector 0.57.0 바이너리로 validate + 실행까지 검증됨).

## 프로세스/포트 뷰어 타당성 조사 (6차 결정)

**동기**: 컨테이너 안에서 node 등을 띄워놓고 까먹어서 포트가 점유된 채로 남는 경우가
잦음 — `btop`을 열어서 찾아 죽이는 걸 웹 UI로 옮기고 싶다는 요청.

**타당성 조사 결과**: 난이도 낮음, 바로 구현 가능하다고 판단.
- 프로세스 목록(pid/이름/cpu%/mem%/커맨드): `github.com/shirou/gopsutil`의 `process`
  패키지가 `/proc` 파싱을 이미 다 해줌 — 순수 Go, cgo 불필요
- 포트 목록 + 점유 프로세스: 같은 라이브러리의 `net.Connections`/`ConnectionsPid`가
  `Pid` 필드까지 포함해서 리턴함
- webmanager는 컨테이너 안에서 root로 실행되므로 다른 프로세스의 `/proc/<pid>/fd` 읽기
  권한 문제도 없음
- kill 액션: Go stdlib만으로 충분

이 판단대로 실제 구현됨 (`internal/procinfo`, gopsutil v4) — 최종 결과는
`webmanager/plan.md` 참고.
