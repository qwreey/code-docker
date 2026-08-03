# 빌드 커스터마이징

각각의 config 폴더 안 파일들은 \*.default.\* 를 복사하여 \*.override.\* 로 바꾸어 원하는대로 작성할 수 있습니다. 예를들면 build.default.sh 를 build.override.sh 로 복사하여 원하는대로 변경할 수 있습니다. 단, sh 파일들은 꼭 `chmod u+x` 를 적용하여 실행가능한 파일로 만들어야합니다.
가급적 업스트림의 변경사항에 따라 필수 바이너리가 따라가도록 하려면 override 파일에서 `/etc/code-docker/build.default.sh` 를 실행하는것을 추천합니다. 다만 원치 않는 경우 하지 않아도 됩니다.
각 override 파일은 편집 후, 컨테이너 재빌드가 필요합니다. `docker compose build 컨테이너명 && docker compose up -d` 를 수행하세요

## 파일 목록

**빌드**
- [`build.*.sh`](#buildsh-빌드-스크립트)

**code-server**
- [`code-service.*.sh`](#code-servicesh-code-server-서비스-진입점)
- [`code-config.*.yaml`](#code-configyaml-code-server-기본-설정)
- [`code-env.*.sh`](#code-envsh-code-server-환경변수)
- [`code-runner.*.sh`](#code-runnersh-code-server-실행-방식)
- [`recommendations.*.yaml`](#recommendationsyaml-추천-목록)
- [`shell.*`](#shell-기본-셸-지정)

**tailscale**
- [`tailscale-service.*.sh`](#tailscale-servicesh-tailscaled-서비스)
- [`tailscale-forward.*.sh`](#tailscale-forwardsh-포트-포워딩)
- [`tailscale-status.*.sh`](#tailscale-statussh-로그인-상태-감시)
- [`tailscale-config.*.yaml`](#tailscale-configyaml-tailscale-기본-설정)

**webmanager**
- [`webmanager.*.sh`](#webmanagersh-webmanager-실행)
- [`supervisor-metadata.*.yaml`](#supervisor-metadatayaml-supervisor-탭-메타데이터)
- [`example-env.webmanager`](../example-env.webmanager) (저장소 루트 파일 — 런타임 환경변수 템플릿)

**기타**
- [`supervisord.*.conf`](#supervisordconf-supervisord-설정)
- [`supervisord/*.conf`](#supervisordconf-추가-프로그램-등록)
- [`user-init.*.sh`](#user-initsh-홈-폴더-초기화)
- [`sshd-service.*.sh`](#sshd-servicesh-sshd-서비스)
- [`code-patch.*.sh`](#code-patchsh-code-patch-심기-스크립트)
- [`code-patch/`](#code-patch-기본-제공-브라우저-패치-모음)
- [`vector-service.*.sh`](#vector-servicesh-vector-실행)
- [`vector.*.toml`](#vectortoml-vector-로그-파이프라인-설정)
- [`nginx-service.*.sh`](#nginx-servicesh-nginx-실행)
- [`nginx.*.conf`](#nginxconf-단일-origin-라우팅-설정)

### `build.*.sh` (빌드 스크립트)

이미지 build 타임에 수행되는 스크립트입니다. pacman 으로 패키지를 설치하기 위해서 사용됩니다. 또한 이 스크립트는 캐시가 마운트된 상태에서 실행됩니다.

### `code-service.*.sh` (code-server 서비스 진입점)

code-server 서비스 엔트리포인트입니다. code-server 의 업데이트/설치와 초기 환경설정이 여기에서 이루워집니다. 동작 보장을 위해서 일반적으로 수정하지 말아야합니다. 환경변수를 설정하고 싶은경우 소싱되는 `code-env.*.sh` 를 편집하세요. 또는 실행 방식을 바꾸려면 `code-runner.*.sh` 를 수정하세요. code-server 의 설정은 `code-config.*.yaml` 이 초기값으로 복사됩니다.

### `code-config.*.yaml` (code-server 기본 설정)

code-server 설정 파일입니다. **매 시작마다 `/code/.server/config.yaml`로 무조건 덮어써집니다** — 다른 override 패턴 파일들과 마찬가지로 완전히 파생된(derived) 파일이라, `/code/.server/config.yaml`을 직접 편집해도 다음 재시작에 사라집니다. 커스터마이징하려면 `code-config.override.yaml`을 만들고 재빌드하세요.

`bind-addr`는 `127.0.0.1:8080`(내부 전용)으로 고정되어 있습니다 — 80번 포트는 이제 컨테이너 안 nginx가 code-server(`/`)와 webmanager(`/manager`)를 함께 라우팅하는 데 쓰이므로(`nginx.*.conf` 참고), override에서 `bind-addr`를 바꾸면 라우팅이 깨집니다.

여기의 각 요소는 /code/.server/code-server/bin/code-server --help 를 통해 확인해볼 수 있습니다. 각각의 인자 `--some=value` 는 `some: value` 로 작성할 수 있습니다.

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

### `tailscale-service.*.sh` (tailscaled 서비스)

`tailscaled` 를 설정하고 실행합니다 (userspace networking 모드). 로그인 세션은 `/code/.tailscale/state` 에 영속되므로, `sshd-service.*.sh` 와 유사하게 재작성할 수 있습니다.

### `tailscale-forward.*.sh` (포트 포워딩)

`/code/.tailscale/config.yaml` 을 읽어 `forwards`(socat + SOCKS5)/`publish`(`tailscale serve`) 를 구성하는 스크립트입니다. `tailscaled`/`tailscale-status` 와 별도 supervisord program 으로 등록되어 있어, 이 스크립트만 (`forward-reload` 로) 재시작해도 `tailscaled` 의 로그인 세션에는 영향을 주지 않습니다.

### `tailscale-status.*.sh` (로그인 상태 감시)

`tailscale status --json` 를 주기적으로 확인해 로그인 필요 여부/URL을 `/code/.server/patch/tailscale/status.json` 에 기록하는 스크립트입니다 (`tailscale-notify.js` 가 폴링하는 대상). `tailscaled`/`tailscale-forward` 와도 별도 supervisord program 이라, 로그인이나 포워딩 상태와 무관하게 항상 동작합니다.

### `tailscale-config.*.yaml` (tailscale 기본 설정)

`/code/.tailscale/config.yaml` 이 아직 없을 때(최초 실행 시) 복사되는 기본값입니다. 이미 생성된 경우 `/code/.tailscale/config.yaml` 을 직접 수정하세요.

### `code-patch.*.sh` (code-patch 심기 스크립트)

`code-patch/` 폴더(아래 참고)의 내용을 `/code/.server/patch/` 로 심는 스크립트입니다. `user-init` 과 마찬가지로 매 부팅마다 항상 실행되지만, `user-init` 과는 별도로 `code-service.*.sh` 에서 (`install.sh` 로 실제 `/code/.server` 가 만들어진 *이후에*) 실행됩니다 - `user-init` 은 fish 설정 등 홈 폴더/셸 초기화를 위한 곳이라, code-server 내부(`/code/.server`)를 다루는 이 로직과는 관심사를 분리했습니다.

### `code-patch/` (기본 제공 브라우저 패치 모음)

code-docker 자체가 기본으로 제공하는 브라우저 패치들(현재는 tailscale 알림용 `tailscale-notify.js`/`cd-dialog.js`) 을 모아두는 폴더입니다. 이 폴더 안의 `<이름>.default.<확장자>` 파일은 각각 `/code/.server/patch/<이름>.<확장자>` 로 - 이미 그 이름의 파일이 없을 때만 - 복사됩니다 (`code-patch.*.sh` 가 매 부팅마다 확인). 같은 폴더에 `<이름>.override.<확장자>` 를 두면(다른 곳의 `*.override.*` 와 동일하게 gitignore 되어 커밋되지 않음) default 대신 그 파일이 복사됩니다. 이미 유저가 오버라이드해서 쓸 수 있는 파일들이라 폴더 이름에는 "default" 를 붙이지 않았습니다.

한 번 `/code/.server/patch/` 에 복사된 뒤에는 직접 수정해도 다음 부팅에 덮어써지지 않습니다 (다른 [코드 서버 패치](code-server-patch.md) 파일과 동일). 다만 이후 code-docker 버전에서 해당 `.default.` 파일이 아예 없어지면, 이전에 심어졌던 사본도 함께 삭제됩니다(`/code/.server/.code-patch-manifest` 로 추적).

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

**이미지를 업데이트했는데 `example-env.webmanager`의 키가 추가/삭제됐다면**,
기존 `.env.webmanager`를 최신 구조에 맞게 재구성하는 `--env-migrate` 서브커맨드가
있습니다:

```sh
cp .env.webmanager .env.webmanager.bak
cat .env.webmanager | docker compose exec -T code-docker \
  /etc/code-docker/webmanager/webmanager --env-migrate > .env.webmanager
```

활성화(주석 해제)해둔 값과 직접 남긴 코멘트는 보존되고, 더 이상 안 쓰이는 키는
지우지 않고 파일 맨 아래 "더 이상 쓰이지 않는 키" 섹션으로 옮겨집니다. `#.`로
시작하는 코멘트는 code-docker가 관리하는 설명이라 매번 갈아끼워지고, 순수 `#`로
시작하는 코멘트만 여러분이 남긴 것으로 취급되어 보존됩니다 — `.env.webmanager`에
직접 메모를 남기고 싶다면 `#.`가 아니라 `#`만 쓰세요. 값을 안 바꿔도 대부분 그냥
잘 동작하긴 합니다(전부 합리적인 기본값이 있음)만, 새로 생긴 설정을 놓치지 않으려면
가끔 확인하는 걸 권장합니다 — `.env.webmanager`의 버전이 이미지가 기대하는 버전과
다르면 컨테이너 로그와 webmanager 웹 UI 양쪽에 알림이 뜹니다.

여러 인스턴스를 운영하며 조직 공통 정책(특정 키를 항상 특정 값으로 강제)을
반영한 커스텀 템플릿을 쓰고 싶다면, `WEBMANAGER_ENV_TEMPLATE_PATH`가 가리키는
경로(기본 `/etc/code-docker/webmanager/example-env.webmanager`)에 볼륨을 하나
마운트해서 이미지 기본 템플릿을 덮어쓰세요(`docker-compose.yml` 참고). 자세한
설계는 `webmanager/.claude/env-migration-plan.md`.

### `vector-service.*.sh` (vector 실행)

`vector` 를 실행합니다. `vector.*.toml` 을 선택해 넘겨주는 것 외에는 `/code/.vector/state`
(체크포인트), `/code/.vector/logs`(구조화 로그) 디렉토리를 미리 만드는 역할만 합니다.

### `vector.*.toml` (vector 로그 파이프라인 설정)

[vector](https://vector.dev) 설정 파일입니다. 각 supervisord program 의 `stdout_logfile`
(`supervisord.*.conf` 참고)을 `file` source 로 tail 해서, 파일 경로에서 프로그램
이름(`app_name`)을 뽑아내고 메시지 내용으로 대략적인 로그 레벨(`level`)을 추정한 뒤 두 곳으로
내보냅니다 — 라벨링된 형태(`[app_name] message`)로 다시 컨테이너 stdout에 재출력(`console`
sink, `docker compose logs` 에서 프로그램 구분이 되도록 함)하고, 동시에
`/code/.vector/logs/YYYY-MM-DD.jsonl` 로 하루 단위 구조화 로그 파일을 씁니다(`file` sink,
`{"timestamp","app_name","level","message"}` 4개 필드만 담은 JSON 한 줄 — webmanager의 로그
뷰어가 여기서 직접 읽습니다). 로그 레벨은 메시지에 `error`/`warn` 등의 문자열이 포함되는지
보는 대략적인 추정치일 뿐이라 정확한 파싱은 아닙니다. `/code/.vector/logs` 는 별도 보존 기간
정책 없이 계속 쌓이므로 필요하면 직접 정리하세요.

### `nginx-service.*.sh` (nginx 실행)

컨테이너 안에서 `nginx -g "daemon off;"`를 실행하는 진입점입니다(`daemon off`는
필수 — 아니면 nginx가 스스로 마스터+워커로 fork해서 supervisord가 워커 프로세스를
직접 관리하지 못하게 됩니다). 어떤 conf 파일을 쓸지는 이 스크립트가 고르므로
(`nginx.override.conf` 있으면 그쪽, 없으면 `nginx.default.conf`), 실행 방식 자체를
바꾸고 싶을 때만 이 파일을 override하세요 — 라우팅 규칙만 바꾸려면 `nginx.*.conf`를
override하는 걸로 충분합니다.

### `nginx.*.conf` (단일 origin 라우팅 설정)

code-server(`/`, 내부 전용 `127.0.0.1:8080`)와 webmanager(`/manager`, 내부 전용
`WEBMANAGER_ADDR`)를 하나의 80번 포트로 합쳐주는 nginx 설정입니다 — 80번 포트에
직접 바인딩하는 유일한 프로그램입니다. `/manager` prefix는 여기서 벗겨져서
webmanager는 지금처럼 `/api/...`를 그대로 받습니다. access/error 로그는 nginx
자신의 stdout/stderr로 나가서 다른 프로그램들과 동일하게 supervisord가 파일로
캡처합니다(`vector`가 그 파일을 다시 tail).

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
