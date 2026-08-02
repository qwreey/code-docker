# webmanager 계획

code-docker 내부 상태(tailscale, mise, supervisord, dind, sshd, git)를 웹 UI 하나에서
들여다보고 조작할 수 있게 하는 관리자 패널. 이 문서는 확정 스펙이 아니라 계획 중인
작업 노트 — 진행하면서 계속 갱신한다.

## 왜 필요한가

지금은 각 기능이 파일 편집 + `docker compose build`/`restart`/`forward-reload` 조합으로
관리된다 (override 패턴, README 참고). 전부 SSH/터미널 접근이 있다는 가정 하에 설계되어
있는데, 브라우저 하나로 상태를 보고 웬만한 조작을 끝낼 수 있으면 편리함.

## 관리 대상 컴포넌트별 현황 (기존 메커니즘 조사 결과)

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

## 확정된 아키텍처 결정

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
   않는 대신, **네트워크 노출 범위를 최소화하는 게 필수적**이 됨 (아래 열린 질문 1번)

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
   구조 — 기존 Dockerfile의 `docker:latest --from=docker-bin` 멀티스테이지 패턴과 동일한
   결

## 잠정 리포지토리 구조

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

빌드/배포는 기존 override 패턴을 그대로 따름:
- `config/webmanager.default.sh` (+ `.override.sh`) → `script/webmanager.sh` 디스패처
- `supervisord.default.conf`에 `[program:webmanager]` 추가
- `Dockerfile`에 프론트 빌드 스테이지(`FROM node:... AS webmanager-frontend`) +
  백엔드 빌드 스테이지(`FROM golang:... AS webmanager-backend`, frontend dist를 COPY 후
  go:embed) 추가, 최종 스테이지엔 컴파일된 바이너리만 COPY
- `docker-compose.yml`에 `81:81` 같은 포트 매핑 추가 (바인드 주소 문제는 미정이므로 지금은
  단순히 열어둠)

## 컴포넌트별 API 표면 (초안, 추후 다듬음)

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

## 3차 질문 답변 반영

### 로깅: vector 도입 확정

서비스가 늘어날수록 `docker compose logs` 통합 로그만으로는 디버깅이 힘들어지므로,
프로그램별 로그 파일 + [vector](https://vector.dev)로 journald 비슷하게 서비스별 조회를
제공하기로 함.

- **supervisord.conf 변경**: 각 `[program:X]`의 `stdout_logfile`을 `/var/log/X/stdout.log`로
  변경 (X = 프로그램 이름, 프로그램마다 다른 디렉토리). 파일 비대화 방지를 위해
  `stdout_logfile_maxbytes=10MB`, `stdout_logfile_backups=3` 유지. 디렉토리는 사전에
  만들어둬야 함 (Dockerfile에서 `mkdir -p /var/log/{code-server,sshd,tailscaled,tailscale-forward,webmanager,vector}`
  또는 각 프로그램 command 앞단에서 `mkdir -p` 후 실행)
- **vector 설정** (`config/vector.default.toml` 같은 형태로 override 패턴 적용 검토):
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
  `app_name` 필드로 프로그램별 필터링 가능 (journalctl -u 느낌). `[api]`는 vector
  top/tap이 쓰는 GraphQL API — webmanager 백엔드가 이 API(127.0.0.1:8686, 컨테이너
  내부에서만 접근 가능)를 호출해서 로그 스트림/필터 UI를 제공. 외부로 이 포트를 노출하지
  않는 게 원칙이지만, "이것 또한 (webmanager) serve에 의해 노출되는 건 의도된 사항"으로
  확인됨 — 즉 vector API 자체를 인터넷에 직접 노출하진 않고 webmanager가 그 앞에서
  프록시/래핑하는 역할
- **설치**: vector는 pacman 공식 저장소엔 없어서 AUR (`yay`) 경유 설치 필요 —
  `script/install-yay.sh`가 이미 있으니 `config/build.default.sh`에 `yay -S vector-bin`
  (또는 `vector`) 추가
- **supervisord program 추가**: `[program:vector]` (command=`/etc/code-docker/vector-service.sh`
  등, override 패턴 재사용)
- **webmanager API**: `GET /api/logs/apps` (vector API로 알려진 app_name 목록/최근 상태),
  `GET /api/logs/:app/stream` (vector API를 통한 tail/follow, SSE 또는 WS로 프론트에 중계)

### ssh authorized_keys 경로 확정

컨테이너 직접 확인 결과:
- `HOME=/code`, 실행 유저는 `root` (uid=0) — Dockerfile에 별도 `USER`/`useradd` 없음
- `sshd_config`의 `AuthorizedKeysFile	.ssh/authorized_keys` (상대경로) → 실제 경로는
  **`/code/.ssh/authorized_keys`**
- 아직 `/code/.ssh` 디렉토리 자체가 없음 — webmanager가 최초 키 추가 시 `mkdir -p -m 700
  /code/.ssh` 하고 파일은 `-m 600`으로 생성해야 함 (sshd가 권한 검사함, 디렉토리/파일이
  group/other에 쓰기 권한 있으면 로그인 거부)

### git 크리덴셜: 두 방식 모두 지원

- **SSH 키 방식**: `~/.ssh/config`에 호스트별 `IdentityFile` 지정 + 키 파일 자체를
  webmanager가 생성/업로드/삭제 관리. 새 키 생성 시 공개키를 보여줘서 GitHub/GitLab에
  등록하도록 안내하는 흐름 필요
- **HTTPS + credential store 방식**: `~/.gitconfig`에 `[credential] helper = store` 설정,
  `~/.git-credentials`에 `https://user:token@host` 형식으로 평문 저장. 평문 저장이라는 점을
  UI에 명시(경고 문구) — 파일 권한은 `600`으로 강제
- UI에서 레포/호스트별로 두 방식 중 선택해서 추가하는 구조로 설계 (라디오 버튼: SSH 키 /
  HTTPS 토큰)
- API 초안: `GET /api/git/config`, `PUT /api/git/config` (gitconfig 필드),
  `GET/POST/DELETE /api/git/ssh-keys` (호스트별 SSH 키 CRUD),
  `GET/POST/DELETE /api/git/credentials` (호스트별 HTTPS 토큰 CRUD, 응답에는 토큰 마스킹)

## MVP 구현 범위 확정 (4차 결정)

**지금 실제로 구현**: supervisord 관리, ssh authorized_keys 관리, git 설정(gitconfig +
ssh 호스트별 키 + HTTPS credential store) — 기존 인프라 재사용이 쉽거나(supervisord) 단순
파일 관리로 끝나는(ssh keys, git) 컴포넌트들

**할 일로만 남겨둠 (지금은 미구현, UI에 "구현 예정" 자리만 잡아둠)**:
- tailscale 관리 (로그인 플로우 UX, config.yaml CRUD)
- mise 관리 (tool/version CRUD)
- dind 관리 (Docker Engine API 프록시)
- 웹쉘 (PTY + WebSocket 터미널)

vector 기반 통합 로깅은 MVP에서는 보류 — supervisord XML-RPC가 이미
`readProcessStdoutLog`/`readProcessStderrLog` 메서드로 로그 조회를 지원하므로, MVP
로그 뷰어는 이를 그대로 사용하고 supervisord.conf의 로그 파일 경로는 당장 안 바꿈. vector
도입은 나중에 다시 논의.

구현은 backend(Go)/frontend(Vite+React) subagent로 나눠 병렬 진행, 완료 후 Dockerfile/
docker-compose.yml/supervisord.conf 통합은 별도로 직접 진행.

## 구현 완료 (1차)

- `webmanager/backend`: Go (stdlib `net/http` + `golang.org/x/crypto/ssh`), supervisord
  XML-RPC 클라이언트(hand-rolled), ssh authorized_keys, gitconfig/ssh-hosts/credentials
  모두 구현 완료. `go build ./...`, `go vet ./...` 통과 확인
- `webmanager/frontend`: Vite + React + TS, 사이드바(3개 구현 + 4개 "구현 예정" 플레이스홀더),
  Supervisor/SSH Keys/Git Config 3개 섹션 구현. `npm run build`, lint 통과 확인
- **Docker 통합**:
  - `Dockerfile`: `webmanager-frontend`(node:24-alpine, `npm ci && npm run build`),
    `webmanager-backend`(golang:1.25-alpine, `CGO_ENABLED=0 go build`) 멀티스테이지 추가,
    최종 이미지의 `/etc/code-docker/webmanager/{webmanager,static}` 로 각각 COPY
  - `config/webmanager.default.sh` + `script/webmanager.sh` — 기존 override 디스패처 패턴
    그대로 적용 (`WEBMANAGER_STATIC_DIR` 만 설정하고 바이너리 실행 — 나머지 env 기본값이
    이미 컨테이너 실경로와 일치해서 별도 설정 불필요)
  - `config/supervisord.default.conf` 에 `[program:webmanager]` 추가
  - `docker-compose.yml` 에 `81:81` 포트 매핑 추가 (바인드 주소 전략은 여전히 미정 — 지금은
    그냥 열어둠, 위 "열린 질문 1" 참고)
  - `.dockerignore` 에 `webmanager/frontend/node_modules`, `dist`, 컴파일된 바이너리 제외 추가
  - `README.md` 에 "webmanager (관리자 패널)" 사용자 팁 섹션 + `webmanager.*.sh` override
    문서 항목 추가

`docker compose build code-docker` 성공 확인, `docker compose up -d` 로 재기동 후 검증 완료:
- `webmanager` supervisord program이 정상적으로 RUNNING 상태로 뜸 (`:81` 리슨 로그 확인)
- `GET /` (프론트 정적 파일) → 200
- `GET /api/supervisor/processes` → 6개 program 전부(code-server/sshd/tailscaled/
  tailscale-forward/tailscale-status/webmanager) RUNNING 상태로 정상 조회됨
- `GET /api/ssh/keys` → `[]` (파일 아직 없음, 정상적으로 빈 배열 반환하고 에러 없음)
- `GET /api/git/config` → `{"name":"","email":""}` (아직 미설정, 정상)

POST/DELETE(키 추가, credential 추가 등)는 실제 컨테이너의 영속 데이터(authorized_keys,
git-credentials)를 건드리게 되므로 이번 검증에서는 실행하지 않음 — 프론트엔드 쪽에서
로컬 스모크 테스트로 이미 확인됨.
