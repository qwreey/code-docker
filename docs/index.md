# 기본 사용법

먼저 이 레포지토리를 적당한 폴더에 클론해야합니다. 아래 명령을 기호에 맞추어 수행하세요.
```sh
mkdir -p ~/code-docker # 데이터와 빌드 파일을 담을 공간을 생성
cd ~/code-docker
mkdir builds # 빌드용 레포지토리 복사
git clone --recurse-submodules https://github.com/qwreey/code-docker.git builds/code-docker
cp builds/code-docker/docker-compose.yml ./ # 컴포즈 파일 복사
```

그런 다음 `example-env` 를 `.env` 로 복사하고, `BUILD_CONTEXT="builds/code-docker"` 로 설정하세요 (레포지토리를 `builds/code-docker` 에 클론했으므로 빌드 컨텍스트가 `docker-compose.yml` 과 다른 위치를 가리켜야 합니다). `docker-compose.yml` 자체는 고칠 필요 없습니다 - 나머지 커스터마이징이 필요하면 마저 읽고 편집하세요.

이제 `docker compose build` 를 수행하고 잘 빌드가 되는지 확인합니다.
만약 빌드에 성공했다면 `docker compose up -d` 를 수행하세요.
잘 구동된다면 성공입니다!
> Note: 시스템 패키지 업데이트를 위해 주기적으로 build 와 up 을 다시 수행해주세요.
> Note: code-docker 업데이트를 수행하려면 `git -C builds/code-docker pull origin master --recurse-submodules` 를 수행하세요

# 기타 환경에 대한 노트와 팁 모음

code-docker 환경은 컨테이너 내부에서 기본적으로 root 유저를 사용합니다. CAP을 따로 추가하지 않고 컨테이너의 네트워크를 적절히 분리한 경우 큰 문제가 되지 않습니다.

`docker-compose.yml` 의 `cap_add` 로 `SYS_PTRACE`, `IPC_LOCK` 이 기본 추가되어있습니다. `SYS_PTRACE` 는 gdb, btop 등 다른 프로세스를 추적/조사하는 디버깅 도구를 위해 필요합니다. `IPC_LOCK` 은 IDE 특성상 IPC 통신이 매우 많이 발생하는데, 이 때 발생할 수 있는 성능 병목을 막기 위함입니다 (익스텐션, LSP 등의 성능에 영향을 줄 수 있습니다). 필요하지 않다면 제거해도 무방합니다.

`$XDG_RUNTIME_DIR` 는 `/run/xdg`로 고정됩니다. 익스텐션이 특정 소켓을 찾는 경우 보통 여기를 찾게 됩니다.

## 보안 (로그인)

code-server는 `auth: none`으로 뜨므로, 앞단 리버스 프록시의 forward-auth(예:
authentik 등 SSO)가 로그인을 전담해야 합니다. PWA 설치가 안 되는 이유(왜 일부
경로는 인증 없이 공개해야 하는지), Caddy/nginx 설정 예시는
[security-login.md](security-login.md)를 확인하세요.

- [PWA 설치가 안 되는 이유](security-login.md#pwa-설치가-안-되는-이유-왜-일부-경로를-공개해야-하는지)
- [Caddy 예시](security-login.md#caddy-예시)
- [nginx를 리버스 프록시로 쓰는 경우](security-login.md#nginx를-리버스-프록시로-쓰는-경우)

## 개발 도구 설치와 환경 변수 재로드

mise 환경이 제공되므로 `mise use -g node`, `mise use -g rust`, `mise use -g rust-analyzer` 등을 수행할 수 있으며, 필요한 경우 `@` 후행으로 버전을 지정하실 수 있습니다.

기본적으로 `use -g`를 통해 설치하면 터미널에는 바로 `PATH`가 적용됩니다. 하지만 확장 프로그램이 요구하는 경우 code-server 서비스의 `PATH`환경이 변경되어야할 수 있습니다.

만약 mise 설치로 인해 global 이 달라졌으며, 이를 code-server 에 적용하고 싶다면 code-server 터미널에 `restart` 를 입력하세요. 이렇게 하면 supervisord 의 code-server 서비스가 재시작하게 되며 env 를 다시 업데이트하게 됩니다. 이는 서비스 시작 시 `mise env --shell` 를 통해 구성됩니다.

## 타임존

기본값은 UTC입니다. `docker-compose.yml`의 `TZ` 환경변수를 원하는 타임존 이름
(예: `Asia/Seoul`)으로 설정하면 됩니다 — `tzdata` 패키지가 이미 설치되어 있어서
`/etc/localtime` 심볼릭 링크를 따로 만들거나 entrypoint를 수정할 필요 없이, glibc가
`TZ` 값만으로 바로 시간대를 계산합니다(`date`, supervisord 로그 타임스탬프,
code-server/Node 등 대부분의 프로세스가 이 방식을 따릅니다). 값을 바꾼 뒤에는
`docker compose up -d`로 재기동하세요(재빌드는 필요 없습니다 — 환경변수만 바뀌는
것이므로).

## ssh 연결

기본적으로 `docker-compose.yml`에서 22 포트가 expose 되지 않습니다. tailscale ip 나 원하는 곳에 `100.64.0.1:22330:22` 형태와 비슷하게 원하는 곳으로 sshd 를 내보내 주시고

```
Host code
  User root
  HostName 100.64.0.1 # 할당한 아이피
  Port 22330 # 외부로 내보낸 할당한 포트
```

형태로 로컬 디바이스의 `~/.ssh/config` 를 설정하고, code-docker 내의 `/code/.ssh/authorized_keys` 에 디바이스 키를 적절히 추가하세요.

## adb 연결

로컬 adb 서버를 ssh 터널 또는 tailscale 포트 가져오기로 code-docker에 연결해서, code-server 안에서 바로 `adb devices`/`gradle`/react native 배포까지 쓸 수 있게 하는 방법입니다.

자세한 내용은 [tips/adb.md](tips/adb.md)를 확인하세요.

## 클립보드 복사 (xclip, wl-copy)

브라우저 기반 터미널이기 때문에 OSC 52 이스케이프 시퀀스로는 클립보드 복사가 되지 않는 경우가 있습니다 (예: Claude Code 등 터미널 프로그램의 클립보드 복사 기능). 이를 위해 `xclip`, `wl-copy` 명령을 흉내내는 셸 스크립트가 `bin/` 에 포함되어 PATH에 제공됩니다. stdin (또는 wl-copy 의 경우 인자로 전달된 텍스트)을 받아 `code-server -c` (브라우저의 Clipboard API 호출)로 전달하는 방식으로 동작합니다. 대부분의 프로그램은 `xclip`/`wl-copy` 바이너리 존재 여부로 클립보드 지원을 판단하므로, 이 스크립트만으로 복사 기능이 자동으로 활성화됩니다. 단, 클립보드 읽기(paste, `xclip -o`)는 지원하지 않습니다.

## Discord presence

vscord 확장으로 Discord Rich Presence를 연동하고, ssh 소켓 포워딩으로 로컬 디스코드 클라이언트와 연결하는 방법입니다.

자세한 내용은 [tips/discord-presence.md](tips/discord-presence.md)를 확인하세요.

## Docker in Docker (dind)

`code-docker-dind` 서비스로 redis, postgres 등 개발용 컨테이너를 code-docker 안에서 바로 `docker run`으로 띄울 수 있습니다.

자세한 내용은 [tips/dind.md](tips/dind.md)를 확인하세요.

## router (네트워크 경계 컨테이너)

code-docker보다 신뢰 수준이 높은 별도 컨테이너(`code-docker-router`)가 code-docker의
네트워크 경계와 관련된 기능을 전담합니다 — 아웃바운드 격리(netgate), tailscale, Dev
Proxy(내부 Caddy), tinyauth(Dev Proxy 라우트별 인증) 네 가지입니다.

자세한 내용은 [router.md](router.md)를 확인하세요.

### 아웃바운드 네트워크 격리 (netgate)

code-docker/dind가 `code-docker-netinit`(및 dind 자신)이 계속 심어주는 라우트를 통해서만 아웃바운드로 나갈 수 있도록 강제하고, router 컨테이너가 실제 국경(사설 대역 차단, DNS 레벨 블록리스트, 인바운드 포트포워딩)을 담당하는 기능입니다 - 컨테이너 안 AI 에이전트가 임의로 인터넷/사설망에 접근하는 걸 막기 위한 것입니다. `docker compose up`만으로 바로 동작합니다.

자세한 내용은 [egress-netgate.md](egress-netgate.md)를 확인하세요 - 기능 자체를 끄고 싶다면 [당장 인터넷이 필요하다면](egress-netgate.md#당장-인터넷이-필요하다면-기능-자체를-끄기) 절을 먼저 보세요.

## 환경 변수 설정 (.env)

`PWA_NAME`, `TZ`, `LANG`, 마운트할 볼륨 경로(`HOME_VOLUME`/`SSHD_VOLUME`/`DIND_VOLUME`), tailscale 관련 값, 로그 상세도 등 `docker-compose.yml`이 읽는 값들은 모두 `example-env`에 설명과 함께 정리되어 있습니다. `example-env`를 `.env`로 복사한 뒤 필요한 값만 주석을 풀어 쓰세요 - 전부 합리적인 기본값이 있어 이 파일이 없어도 정상 동작합니다. 값을 바꾼 뒤에는 `docker compose up -d`로 컨테이너를 재생성해야 반영됩니다.

```sh
cp example-env .env
```

## 여러 code-docker 인스턴스 사용

여러 인스턴스 구동 시 container_name 이 겹칠 수 있습니다. `.env`에 `PREFIX`를 적절히 설정해주면 해결됩니다 (기본적으로 `${PREFIX:-}`를 붙여서 `docker-compose.yml`을 제공합니다).

## tailscale 연결

router 컨테이너(code-docker 자신이 아님, [router.md](router.md) 참고)가 고유한
tailscale IP를 가지도록 하여, ssh/adb 를 위해 별도로 포트를 열거나 `ssh -R` 로 소켓을
전송하지 않고도 tailnet 안 어디서든 code-docker 에 접근하거나, 반대로 code-docker 에서
다른 tailnet 기기의 포트를 가져올 수 있습니다.

자세한 내용은 [router.md의 tailscale 절](router.md#tailscale)을 확인하세요 — 이
문서(`tailscale.md`)는 이제 짧은 안내 페이지입니다.

## dev 서버 노출 (Dev Proxy)

컨테이너 안에서 뜬 dev 서버(`npm run dev` 등)를 와일드카드 서브도메인으로 바깥에 노출하는 기능입니다. router 컨테이너의 내부 Caddy 인스턴스가 서브도메인별로 로컬 포트로 프록시하고, [webmanager의 Dev Proxy 탭](webmanager.md)에서 항목을 관리합니다(router가 제공하는 페이지 컴포넌트를 webmanager가 그대로 가져와 보여줍니다).

자세한 내용은 [dev-proxy.md](dev-proxy.md)를 확인하세요.

- [켜고 끄기 / 기본 설정](dev-proxy.md#켜고-끄기--기본-설정)
- [expose 추가하기](dev-proxy.md#expose-추가하기)
- [바깥 리버스 프록시 연결하기](dev-proxy.md#바깥-리버스-프록시-연결하기)
- [인증](dev-proxy.md#인증) — [router의 tinyauth](router.md#tinyauth)에 최소 한 명의 사용자가 등록되어 있어야 합니다, 놓치기 쉬운 필수 설정입니다

## webmanager (관리자 패널)

80번 포트의 code-server 와 같은 origin, `/manager` 경로에 브라우저 관리자 패널이 함께 떠 있습니다 (Go 백엔드 + React 프론트엔드, `webmanager/` 폴더에서 개발됩니다) — 컨테이너 안 nginx가 `/manager`를 webmanager로, 나머지를 code-server로 라우팅해줍니다. 별도 포트로 직접 열고 싶다면(예: nginx를 거치지 않고 붙고 싶은 경우) `.env.webmanager`의 `WEBMANAGER_ADDR`를 `:81`로 바꾸고 `docker-compose.yml`의 주석 처리된 `81:81` 매핑을 되살리세요.

자세한 내용(각 탭 설명)은 [webmanager.md](webmanager.md)를 확인하세요.

- [Supervisor](webmanager.md#supervisor)
- [SSH Keys](webmanager.md#ssh-keys)
- [Git Config](webmanager.md#git-config)
- [Dev Proxy](webmanager.md#dev-proxy)
- [Logs](webmanager.md#logs)
- [Task Manager](webmanager.md#task-manager)
- [Claude Code](webmanager.md#claude-code)
- [Code Extensions](webmanager.md#code-extensions)
- [Projects](webmanager.md#projects)
- [mise](webmanager.md#mise)
- [Terminal](webmanager.md#terminal)
- [Files](webmanager.md#files)
- [Docker/dind 관리](webmanager.md#dockerdind-관리)

### webmanager 설정 (비밀번호 / 환경 변수 마이그레이션)

webmanager 자체 비밀번호 게이트를 켜는 방법과, 이미지를 업데이트한 뒤
`.env.webmanager`를 최신 구조로 재구성하는 `--env-migrate` 사용법은
[webmanager-config.md](webmanager-config.md)를 확인하세요.

- [비밀번호 게이트](webmanager-config.md#비밀번호-게이트) — 기본 꺼짐, 외부 노출 시 설정 강력 권장
- [마이그레이션 (env-migrate)](webmanager-config.md#마이그레이션-env-migrate)

# 빌드 커스터마이징

각각의 config 폴더 안 파일들은 \*.default.\* 를 복사하여 \*.override.\* 로 바꾸어 원하는대로 작성할 수 있습니다. 예를들면 build.default.sh 를 build.override.sh 로 복사하여 원하는대로 변경할 수 있습니다. 단, sh 파일들은 꼭 `chmod u+x` 를 적용하여 실행가능한 파일로 만들어야합니다. 각 override 파일은 편집 후, 컨테이너 재빌드가 필요합니다 (`docker compose build 컨테이너명 && docker compose up -d`).

전체 파일 목록과 각 파일의 역할은 [build-customization.md](build-customization.md)에 정리되어 있습니다:

- **빌드**: `build.*.sh`
- **code-server**: `code-service.*.sh`, `code-config.*.yaml`, `code-env.*.sh`, `code-runner.*.sh`, `recommendations.*.yaml`, `shell.*`
- **webmanager**: `webmanager.*.sh`, `supervisor-metadata.*.yaml`, `example-env.webmanager`(런타임 환경변수 템플릿, 저장소 루트)
- **기타**: `supervisord.*.conf`, `supervisord/*.conf`, `user-init.*.sh`, `sshd-service.*.sh`, `code-patch.*.sh`, `code-patch/`, `vector-service.*.sh`(`VECTOR_LOG_LEVEL`로 vector 자체 진단 로그 상세도 조절), `vector.*.toml`, `nginx-service.*.sh`, `nginx.*.conf`(code-server `/` + webmanager `/manager` 단일 origin 라우팅 + router로 가는 `/tailscale/`·`/dev-proxy/`·`/exports/` 프록시, `NGINX_LOG_LEVEL`로 access_log 상세도 조절), `nginx-error.*.html`(code-server가 아직 안 떴을 때 502 대신 보여주는 자동 재시도 페이지)

router 컨테이너(`router/` 서브트리) 자체의 override 파일 목록은 [router.md](router.md)를
확인하세요 — `router/config/netgate/`, `router/config/tailscale/`,
`router/config/caddy-adapter/`에 나뉘어 있습니다. router 전용 기능
환경변수(tailscale/Dev Proxy/router-manager 자체 비밀번호/tinyauth)는
`router/example-env.router`(런타임 템플릿, `router/.env.router`로 복사해
사용) — webmanager와 같은 `--env-migrate` 마이그레이션 도구를 공유합니다,
자세한 내용은 [router.md#router-환경변수-마이그레이션](router.md#router-환경변수-마이그레이션) 참고.

# 코드 서버 패치

폰트나 css, js 를 커스텀으로 로드하고 싶은 경우 `/code/.local/share/code-docker/code/patch` 폴더를 만들어 안에 css, js 를 만들어줄 수 있습니다. PWA 이름/아이콘, 타이틀바 아이콘 변경 방법도 포함됩니다.

자세한 내용은 [code-server-patch.md](code-server-patch.md)를 확인하세요.

기본으로 몇 가지 js 가 이 방식으로 주입됩니다 — 예를 들어 tailscale 로그인이 필요할 때 배너를 띄우는 `tailscale-notify.default.js`, 그리고 타이틀바 좌측 위 아이콘(`.window-appicon`)을 클릭하면 webmanager(위 "webmanager (관리자 패널)" 섹션 참고)를 오버레이 모달로 열어주는 `webmanager-launcher.default.js`가 있습니다. 다른 override 파일들처럼 `config/code-patch/webmanager-launcher.override.js`를 만들어 동작을 바꿀 수 있습니다.
