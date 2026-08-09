# 빌드 커스터마이징

`config/` 아래는 프로그램별 폴더(`build/`, `code/`, `nginx/`, `resolv-writer/`, `shell/`, `sshd/`, `user-init/`, `vector/`, `webmanager/`)로 나뉘어 있습니다 — 각 폴더 안 파일들은 \*.default.\* 를 복사하여 \*.override.\* 로 바꾸어 원하는대로 작성할 수 있습니다. 예를들면 `config/build/build.default.sh` 를 같은 폴더에 `build.override.sh` 로 복사하여 원하는대로 변경할 수 있습니다. 단, sh 파일들은 꼭 `chmod u+x` 를 적용하여 실행가능한 파일로 만들어야합니다.
가급적 업스트림의 변경사항에 따라 필수 바이너리가 따라가도록 하려면 override 파일에서 `/etc/code-docker/build/build.default.sh` 를 실행하는것을 추천합니다. 다만 원치 않는 경우 하지 않아도 됩니다.
각 override 파일은 편집 후, 컨테이너 재빌드가 필요합니다. `docker compose build 컨테이너명 && docker compose up -d` 를 수행하세요

## 파일 목록

**`config/build/`**
- [`build.*.sh`](#buildsh-빌드-스크립트)

**`config/code/`**
- [`code-service.*.sh`](#code-servicesh-code-server-서비스-진입점)
- [`code-config.*.yaml`](#code-configyaml-code-server-기본-설정)
- [`code-env.*.sh`](#code-envsh-code-server-환경변수)
- [`code-runner.*.sh`](#code-runnersh-code-server-실행-방식)
- [`recommendations.*.yaml`](#recommendationsyaml-추천-목록)
- [`code-patch.*.sh`](#code-patchsh-code-patch-심기-스크립트)
- [`code-patch/`](#code-patch-기본-제공-브라우저-패치-모음)

**`config/shell/`**
- [`shell.*`](#shell-기본-셸-지정)

**`config/webmanager/`**
- [`webmanager.*.sh`](#webmanagersh-webmanager-실행)
- [`example-env.webmanager`](../example-env.webmanager) (저장소 루트 파일 — 런타임 환경변수 템플릿)

**`config/` (프로그램 폴더 밖 — supervisord/전역 메타데이터)**
- [`supervisord.*.conf`](#supervisordconf-supervisord-설정)
- [`supervisord/*.conf`](#supervisordconf-추가-프로그램-등록)
- [`supervisor-metadata.*.yaml`](#supervisor-metadatayaml-supervisor-탭-메타데이터)

**`config/user-init/`**
- [`user-init.*.sh`](#user-initsh-홈-폴더-초기화)

**`config/sshd/`**
- [`sshd-service.*.sh`](#sshd-servicesh-sshd-서비스)

**`config/resolv-writer/`**
- [`resolv-writer.*.sh`](#resolv-writersh-router-dns로-nameserver-갱신)

**`config/vector/`**
- [`vector-service.*.sh`](#vector-servicesh-vector-실행)
- [`vector.*.toml`](#vectortoml-vector-로그-파이프라인-설정)

**`config/nginx/`**
- [`nginx-service.*.sh`](#nginx-servicesh-nginx-실행)
- [`nginx.*.conf`](#nginxconf-단일-origin-라우팅-설정)
- [`nginx-error.*.html`](#nginx-errorhtml-code-server-준비-중-페이지)

### `build.*.sh` (빌드 스크립트)

이미지 build 타임에 수행되는 스크립트입니다. pacman 으로 패키지를 설치하기 위해서 사용됩니다. 또한 이 스크립트는 캐시가 마운트된 상태에서 실행됩니다.

### `code-service.*.sh` (code-server 서비스 진입점)

code-server 서비스 엔트리포인트입니다. code-server 의 업데이트/설치와 초기 환경설정이 여기에서 이루워집니다. 동작 보장을 위해서 일반적으로 수정하지 말아야합니다. 환경변수를 설정하고 싶은경우 소싱되는 `code-env.*.sh` 를 편집하세요. 또는 실행 방식을 바꾸려면 `code-runner.*.sh` 를 수정하세요. code-server 의 설정은 `code-config.*.yaml` 이 초기값으로 복사됩니다.

### `code-config.*.yaml` (code-server 기본 설정)

code-server 설정 파일입니다. **매 시작마다 `/code/.local/share/code-docker/code/config.yaml`로 무조건 덮어써집니다** — 다른 override 패턴 파일들과 마찬가지로 완전히 파생된(derived) 파일이라, `/code/.local/share/code-docker/code/config.yaml`을 직접 편집해도 다음 재시작에 사라집니다. 커스터마이징하려면 `code-config.override.yaml`을 만들고 재빌드하세요.

**`bind-addr`는 여기 넣지 마세요 — 넣어도 무시됩니다.** `code-runner.default.sh`가 항상 `--bind-addr` CLI 인자를 붙여서 실행하는데, code-server는 CLI 인자를 config.yaml 값보다 우선하므로 여기(default든 override든)에 뭘 적어도 그 값이 이깁니다. 실제 바인드 주소를 바꾸고 싶으면 `docker-compose.yml`의 `CODE_SERVER_BIND_ADDR`(기본값 `private:8080`)을 바꾸세요 — nginx의 upstream 대상도 같은 값을 따라가므로(`nginx-service.default.sh`) 라우팅이 어긋날 걱정 없이 이거 하나만 바꾸면 됩니다. `private`는 `code-docker-internal` 네트워크 alias일 뿐(전용 tailscale IP가 아닙니다 — tailscale은 이제 [router 컨테이너](router.md)에서 실행되고, code-docker 자신은 tailscaled를 갖고 있지 않습니다), loopback 대신 이 alias에 바인드해야 할 필수적인 이유는 더 이상 없지만 기본값은 그대로 유지하고 있습니다.

여기의 각 요소는 /code/.local/share/code-docker/code/code-server/bin/code-server --help 를 통해 확인해볼 수 있습니다. 각각의 인자 `--some=value` 는 `some: value` 로 작성할 수 있습니다.

### `recommendations.*.yaml` (추천 목록)

webmanager의 "Code Extensions" 탭이 추천 목록으로 보여주는 code-server 익스텐션 목록입니다
(추후 mise 도구 추천 목록도 이 파일에 `mise:` 최상위 키로 추가될 예정). 여러 사용자에게
같은 이미지를 배포하는 경우, 이 파일을 override해서 조직에 맞는 추천 목록으로 완전히
교체할 수 있습니다.

### `supervisor-metadata.*.yaml` (Supervisor 탭 메타데이터)

webmanager의 "Supervisor" 탭이 각 supervisord 프로그램에 대해 보여주는 메타데이터입니다.
프로그램 이름을 키로 하여 표시 라벨(`label`), 설명 노트(`note`), 그리고 시작/중지/재시작/
로그보기 버튼을 각각 비활성화할지(`disableStart`/`disableStop`/`disableRestart`/
`disableLogs`, 모두 boolean) 지정할 수 있습니다. 모든 필드는 선택 사항이며, 목록에 없는
프로그램은 아무것도 비활성화되지 않습니다.

기본값은 `vector`(로그 파이프라인 프로세스)의 로그보기 버튼만 비활성화합니다 — 이 프로세스가
만드는 로그를 다른 프로그램들의 로그로 가공해 Logs 탭에서 보여주는 것이 이 프로세스의 역할이므로,
자기 자신의 표준출력을 이 메커니즘으로 다시 보여줄 이유가 없기 때문입니다.

```yaml
programs:
  vector:
    note: 내부 로그 파이프라인 프로세스입니다. ...
    disableLogs: true
```

### `code-env.*.sh` (code-server 환경변수)

`code-service.*.sh` 가 code-server 를 실행하기전 소싱하는 파일입니다. 일반적으로 환경변수를 설정하는데 사용합니다.

### `code-runner.*.sh` (code-server 실행 방식)

code-server 를 어떻게 수행할지 정의합니다. qwreey/code-server-autoinstall 이 제공하는 start.sh 의 래퍼이며 mise 가 제공하는 툴킷을 code-server 에 환경변수로써 알려주기 위해서 mise env 를 수행합니다.

### `supervisord.*.conf` (supervisord 설정)

supervisord 에 사용될 설정파일입니다.

### `user-init.*.sh` (홈 폴더 초기화)

유저 홈폴더 (/code) 가 처음 생성될 때 수행되는 작업을 설정합니다. 모든 동작은 /code 안에서 행해야합니다. 그렇지 않으면 컨테이너가 꺼질 때 작업이 저장되지 않습니다. 또한 마이그레이션이 필요한 경우를 위해 이 스크립트는 항상 실행됩니다 - 홈의 업데이트 필요 유무는 직접 구현해야합니다.

여기에서 fish 셸의 설정이 초기화됩니다. 만약 fish 이외의 다른 셸의 설정을 초기화 시키고 싶은 경우 덮어써야합니다.

### `sshd-service.*.sh` (sshd 서비스)

sshd 를 설정하고 실행합니다. 기본적으로 `/etc/ssh`는 적절한 마운트가 있어 유지됩니다. 따라서 `user-init` 과 유사하게 작성할 수 있습니다.

tailscale 관련 override 파일(`tailscale-service.*.sh`, `tailscale-forward.*.sh`,
`tailscale-publish.*.sh`, `tailscale-config.*.yaml`)은 이제 code-docker가 아니라
**router** 컨테이너(`router/config/tailscale/`)에 있습니다 — 같은 override 패턴이지만
재빌드 대상이 `code-docker-router` 서비스입니다. 자세한 내용은 [router.md](router.md)를
확인하세요.

### `resolv-writer.*.sh` (router DNS로 nameserver 갱신)

`code-docker-internal` 네트워크가 `internal: true`라 Docker 자체 내장 DNS(`127.0.0.11`)가
외부로 쿼리를 포워딩하지 못하기 때문에, router 컨테이너가 대신 실제 DNS 포워더(dnsmasq)를
띄웁니다 — 이 supervisord 프로그램이 5초마다 `router`의 IP를 다시 조회해서
`/etc/resolv.conf`에 두 번째 nameserver로 반영합니다(router가 재생성돼 IP가 바뀌어도 계속
따라감). `entrypoint.sh`도 부팅 시 한 번 동기적으로 같은 일을 하고, `code-docker-dind`도
자기 자신의 `/etc/resolv.conf`에 동일한 로직을 씁니다 — 세 곳 모두 저장소 루트
`netshare/apply-nameserver.sh`의 `apply_nameserver` 함수를 공유합니다(직접 수정할 일은
거의 없는 파일이지만, override한다면 이 공유 함수를 계속 쓰는 걸 권장합니다).

### `code-patch.*.sh` (code-patch 심기 스크립트)

`code-patch/` 폴더(아래 참고)의 내용을 `/code/.local/share/code-docker/code/patch/` 로 심는 스크립트입니다. `user-init` 과 마찬가지로 매 부팅마다 항상 실행되지만, `user-init` 과는 별도로 `code-service.*.sh` 에서 (`install.sh` 로 실제 `/code/.local/share/code-docker/code` 가 만들어진 *이후에*) 실행됩니다 - `user-init` 은 fish 설정 등 홈 폴더/셸 초기화를 위한 곳이라, code-server 내부(`/code/.local/share/code-docker/code`)를 다루는 이 로직과는 관심사를 분리했습니다.

### `code-patch/` (기본 제공 브라우저 패치 모음)

code-docker 자체가 기본으로 제공하는 브라우저 패치들(현재는 `tailscale-notify.js`, `cd-dialog.js`, `router-auth-notify.js`, `session-heartbeat.js`, `webmanager-launcher.js`)을 모아두는 폴더입니다. 이 폴더 안의 `<이름>.default.<확장자>` 파일은 각각 `/code/.local/share/code-docker/code/patch/<이름>.<확장자>` 로 복사됩니다 (`code-patch.*.sh` 가 매 부팅마다 확인). 같은 폴더에 `<이름>.override.<확장자>` 를 두면(다른 곳의 `*.override.*` 와 동일하게 gitignore 되어 커밋되지 않음) default 대신 그 파일이 복사됩니다. 이미 유저가 오버라이드해서 쓸 수 있는 파일들이라 폴더 이름에는 "default" 를 붙이지 않았습니다.

매 부팅마다 다시 심어지지만, 대상 파일의 내용이 지난번에 심었을 때의 해시와 여전히 일치할 때만입니다 — 즉 유저가 직접 수정하지 않은 파일만 갱신됩니다(`/code/.local/share/code-docker/code/.code-patch-manifest` 로 `<이름>\t<해시>` 를 추적, 다른 [코드 서버 패치](code-server-patch.md) 파일과 동일한 재시드 규칙). 해시가 다르면(유저가 직접 고쳤거나, 아직 기록된 해시가 없는 경우) 건드리지 않고 그대로 둡니다. 이후 code-docker 버전에서 해당 `.default.` 파일이 아예 없어지면, 이전에 심어졌던 사본도 함께 삭제됩니다.

### `shell.*` (기본 셸 지정)

`chsh` 명령을 통해 `root` 유저의 셸을 설정할 때 사용할 셸 바이너리의 path 를 가르킵니다. 기본적으로 `/bin/fish` 이지만, `/bin/bash` 또는 `/bin/zsh` 등으로 바꾸는데 사용할 수 있습니다.

### `supervisord/*.conf` (추가 프로그램 등록)

supervisord 에 원하는 프로그램을 서비스로 등록하고 싶을 때 사용할 수 있습니다. 기본적으로 `supervisord.default` 의 `include` 부분에 의해서 임포트 됩니다. [파일 포멧에 관해서는 supervisord 의 공식 문서 program 부분](https://supervisord.org/configuration.html#program-x-section-settings)을 확인하세요

### `webmanager.*.sh` (webmanager 실행)

webmanager 바이너리를 실행합니다 ([webmanager (관리자 패널)](webmanager.md) 참고).
바이너리와 프론트엔드 정적 파일은 `webmanager/backend`, `webmanager/frontend` 를 빌드 타임에
컴파일/빌드하여 `/etc/code-docker/webmanager/` 에 넣어둔 것이라, 이 스크립트에서 바로
편집할 수 있는 부분은 없고 환경변수만 다룹니다. 설정 가능한 값 전체 목록과 설명은
저장소 루트의 `example-env.webmanager`를 확인하세요 - 이 파일을 `.env.webmanager`로
복사하면 `docker-compose.yml`이 자동으로 읽어들입니다(더 자세한 내부 동작은
`webmanager/backend/README.md` 참고).

이미지를 업데이트했는데 `example-env.webmanager`의 키가 추가/삭제됐다면 기존
`.env.webmanager`를 최신 구조로 재구성하는 `--env-migrate` 서브커맨드가 있고,
webmanager 자체 비밀번호 게이트를 켜는 법도 별도로 정리되어 있습니다 —
[webmanager-config.md](webmanager-config.md)를 확인하세요.

### `vector-service.*.sh` (vector 실행)

`vector` 를 실행합니다. `vector.*.toml` 을 선택해 넘겨주는 것 외에는 `/code/.local/share/code-docker/vector/state`
(체크포인트), `/code/.local/share/code-docker/vector/logs`(구조화 로그) 디렉토리를 미리 만드는 역할만 합니다.

vector 자신의 내부 진단 로그(설정 로드, 헬스체크, 파일 워처 시작/재개, 체크포인트
로드, "Vector has started" 배너 등 — 아무 `[app_name]` 태그 없이 stdout에 그대로
찍히는 잡음)는 `docker-compose.yml`의 `VECTOR_LOG_LEVEL`로 조절합니다. 기본값
`warn`은 nginx의 `error_log ... warn;`과 같은 레벨로 맞춘 것으로, 위 잡음은 대부분
사라지고 실제 파이프라인 문제(WARN 이상)만 남습니다. 이 값은 다른 프로그램들의
로그를 실어나르는 파이프라인 데이터 자체(`console` sink 재출력,
`/code/.local/share/code-docker/vector/logs/*.jsonl`)와는 무관합니다 — 더 조용하게 하려면 `error`, 옛날
동작으로 되돌리려면 `info`나 `debug`로 설정하세요.

### `vector.*.toml` (vector 로그 파이프라인 설정)

[vector](https://vector.dev) 설정 파일입니다. 각 supervisord program 의 `stdout_logfile`
(`supervisord.*.conf` 참고)을 `file` source 로 tail 해서, 파일 경로에서 프로그램
이름(`app_name`)을 뽑아내고 메시지 내용으로 대략적인 로그 레벨(`level`)을 추정한 뒤 두 곳으로
내보냅니다 — 라벨링된 형태(`[app_name] message`)로 다시 컨테이너 stdout에 재출력(`console`
sink, `docker compose logs` 에서 프로그램 구분이 되도록 함)하고, 동시에
`/code/.local/share/code-docker/vector/logs/YYYY-MM-DD.jsonl` 로 하루 단위 구조화 로그 파일을 씁니다(`file` sink,
`{"timestamp","app_name","level","message"}` 4개 필드만 담은 JSON 한 줄 — webmanager의 로그
뷰어가 여기서 직접 읽습니다). 로그 레벨은 메시지에 `error`/`warn` 등의 문자열이 포함되는지
보는 대략적인 추정치일 뿐이라 정확한 파싱은 아닙니다. `/code/.local/share/code-docker/vector/logs` 는 별도 보존 기간
정책 없이 계속 쌓이므로 필요하면 직접 정리하세요.

`tailscaled`는 다른 프로그램들과 비교해 유독 시끄럽습니다 — 재시작 한 번에 DNS
모드 선택/WireGuard 장치 생성/컨트롤 플레인 루틴 추적 같은 내부 구현 상세를
수십 줄씩 찍고, 평상시에도 magicsock/netcheck/derp/라우트 감시 관련 잡음이
하루 수십만 줄까지 쌓입니다(이 프로젝트 호스트에서 직접 측정: `journalctl -u
tailscaled` 393,830줄 중 실제 신호(ipn 상태 전환/인증 URL/fatal 에러)는 403줄뿐).
이건 이 프로젝트나 컨테이너 특유의 문제가 아니라 tailscale 팀도 인정한
오래된 업스트림 이슈입니다(로그 레벨 자체가 없어서 팀이 제안하는 방법도
"외부에서 필터링"뿐 — [tailscale/tailscale#282](https://github.com/tailscale/tailscale/issues/282),
실사용자 보고로 tailscaled 로그가 200GB까지 쌓이거나 특정 메시지가 몇 달째
2-3초 간격으로 찍히는 사례가 있습니다). nginx의 `NGINX_LOG_LEVEL`처럼 상태코드
같은 깔끔한 필터 기준이 없어서, `docker-compose.yml`의
`TAILSCALE_LOG_LEVEL`(기본값 `errors`)은 tailscaled 프로그램에 한해 블록리스트가
아니라 허용리스트 방식으로 걸러냅니다 — 로그인/인증 URL, ipn 상태 전환
(`NeedsLogin`/`Starting`/`Running`/...), fatal 에러만 통과시키고 나머지 내부
구현 상세는 버립니다(다른 프로그램의 로그는 전혀 건드리지 않음). `all`로
설정하면 tailscaled도 필터링 없이 예전처럼 전부 찍힙니다.
`vector.default.toml`의 `get_env_var`로 이벤트마다 직접 읽으므로, 값을 바꿔도
vector 재시작만 하면 되고 nginx의 envsubst 같은 재렌더링은 필요 없습니다.

### `nginx-service.*.sh` (nginx 실행)

컨테이너 안에서 `nginx -g "daemon off;"`를 실행하는 진입점입니다(`daemon off`는
필수 — 아니면 nginx가 스스로 마스터+워커로 fork해서 supervisord가 워커 프로세스를
직접 관리하지 못하게 됩니다). 어떤 conf 파일을 쓸지는 이 스크립트가 고르므로
(`nginx.override.conf` 있으면 그쪽, 없으면 `nginx.default.conf`), 실행 방식 자체를
바꾸고 싶을 때만 이 파일을 override하세요 — 라우팅 규칙만 바꾸려면 `nginx.*.conf`를
override하는 걸로 충분합니다.

### `nginx.*.conf` (단일 origin 라우팅 설정)

code-server(`/`, 내부 전용 `private:8080`)와 webmanager(`/manager`, 내부 전용
`WEBMANAGER_ADDR`)를 하나의 80번 포트로 합쳐주는 nginx 설정입니다 — 80번 포트에
직접 바인딩하는 유일한 프로그램입니다. `/manager` prefix는 여기서 벗겨져서
webmanager는 지금처럼 `/api/...`를 그대로 받습니다. access/error 로그는 nginx
자신의 stdout/stderr로 나가서 다른 프로그램들과 동일하게 supervisord가 파일로
캡처합니다(`vector`가 그 파일을 다시 tail). tailscale의 자동 loopback 포워딩
경로(`127.0.0.1`로 들어온 요청)만 따로 거부하는 조건(`NGINX_BLOCK_LOOPBACK`,
기본 켜짐 — router가 code-docker를 향해 publish하는 경로는 아니지만, router가
사용자 대신 tailnet peer로부터 받은 트래픽이 우회 경로로 들어올 가능성에 대한
방어 차원으로 유지)과, `ALLOWED_HOSTS`로 조절하는 Host 헤더 화이트리스트도 이
파일에 있습니다. `/tailscale/`·`/dev-proxy/`·`/exports/` 위치는 더 이상 여기서
router로 프록시되지 않습니다 — router가 host:80을 직접 종단하도록 바뀌면서
(`router/config/nginx/`) 이 파일에서는 빠졌고, webmanager의 Tailscale/Dev Proxy
탭도 이제 router 자신의 `/router/` 경로로 직접 호출합니다. 자세한 내용은
[router.md](router.md) 참고. `TRUSTED_PROXIES`(외부 리버스 프록시의 IP/CIDR를 알려주면 `$remote_addr`가
그 프록시의 X-Forwarded-For를 신뢰해서 실제 클라이언트 IP로 채워짐, 기본 빈 값)도
같이 있습니다.

access_log 상세도는 `docker-compose.yml`의 `NGINX_LOG_LEVEL`로 조절합니다.
기본값 `errors`는 응답 상태코드가 4xx/5xx인 요청만 기록합니다(nginx의 표준
`map $status $loggable` + `access_log ... if=$loggable` 기법) — 매 요청이 다
찍히던 예전 동작(`all`로 설정하면 복원됩니다)이 정상적인 200 OK 트래픽까지
`docker compose logs`에 전부 쏟아내서 다른 프로그램 로그를 묻어버렸기 때문입니다.
이 conf 파일은 nginx가 자체적으로 셸 환경변수를 치환하지 못하므로, 정적 파일이
아니라 템플릿입니다 — `nginx-service.default.sh`가 시작 시 `envsubst`로
`${NGINX_ACCESS_LOG_IF}` 자리를 채운 렌더링 결과(`/run/nginx.generated.conf`)를
만들어 그걸로 nginx를 실행합니다. override 작성 시 이 자리표시자를 그대로 두면
`NGINX_LOG_LEVEL` 토글이 계속 동작하고, 지우면 그냥 고정된 access_log 동작이
됩니다.

### `nginx-error.*.html` (code-server 준비 중 페이지)

`location /`(code-server 프록시)에서 upstream(`private:8080`)에 연결할 수
없어 502/503/504가 나면, nginx의 기본 에러 페이지 대신 이 파일을 대신
보여줍니다 — 컨테이너가 막 시작했거나 code-server가 재시작 중이라 아직
포트가 열리지 않은, 실제로는 에러가 아닌 흔한 상황을 사용자에게 "곧
끝난다"고 알려주기 위함입니다. 페이지 안 JS가 몇 초 간격으로 같은 주소를
`fetch`해보고, 200이 돌아오는 순간 자동으로 새로고침합니다(수동 "지금 다시
확인" 버튼도 있음). webmanager로 바로 가는 링크도 있어서, code-server가
왜 안 뜨는지 로그(Logs 탭)로 바로 확인할 수 있습니다 — webmanager는
별도 supervisord 프로그램이라 code-server가 죽어있어도 보통 정상 응답합니다.

`/manager/`(webmanager) 쪽에는 이 처리가 걸려있지 않습니다 — 이 페이지가
다루는 시나리오는 code-server 기동 지연이지, webmanager 쪽 문제가 아니기
때문입니다.

이 파일은 `nginx.*.conf`처럼 envsubst 템플릿이 아니라 순수 정적 HTML입니다.
`location = /_code_not_ready.html` 블록이 `try_files`로 `nginx-error.
override.html`을 먼저 찾고, 없으면 `nginx-error.default.html`을 씁니다 —
override 파일을 만들면 셸 스크립트를 거치지 않고 바로 nginx가 선택합니다.
