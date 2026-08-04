# code-docker

![image](https://github.com/user-attachments/assets/ebd212a9-e620-46c4-9cd0-dbcbf1a55b69)

개인적인 목적의 code-server 도커 이미지입니다. `qwreey/qwreey-fish` 와 통합되어있습니다. mise 환경이 제공되며, `mise use -g node@26.4.0 uv` 등의 명령으로 원하는 개발 도구를 빌드 타임이 아닌 런타임에 설치할 수 있습니다. 또한 빌드 타임에 yay 를 통한 aur 설치나 pacman 을 통한 공식 arch 패키지를 설치할 수 있습니다.

 - GCC: arch linux 의 base-devel, cmake 패키지가 제공됩니다.
 - openssh: arch linux 의 openssh 패키지가 제공됩니다. 또한 호스트키가 미리 설정됩니다. code-server 안에서 /code/.ssh 폴더를 생성하고 authorized_keys 를 적절하게 설정하면 됩니다.

필요한 경우 시스템 패키지를 임의로 추가할 수 있습니다 아래 커스터마이징을 확인하세요

# 기본 사용법

먼저 이 레포지토리를 적당한 폴더에 클론해야합니다. 아래 명령을 기호에 맞추어 수행하세요.
```sh
mkdir -p ~/code-docker # 데이터와 빌드 파일을 담을 공간을 생성
cd ~/code-docker
mkdir builds # 빌드용 레포지토리 복사
git clone --recurse-submodules https://github.com/qwreey/code-docker.git builds/code-docker
cp builds/code-docker/docker-compose.yml ./ # 컴포즈 파일 복사
```

그런 다음 `docker-compose.yml` 파일을 읽고 편집하세요. 특히 `build: .` 부분은 `build: builds/code-docker` 로 꼭 변경되어야합니다.

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

authentik등의 sso 프로바이더를 사용하는것을 추천합니다. 일반적으로 caddyfile 은 아래와 같이 구성합니다.

```Caddy
code.yaeji.moe {
  import common
  reverse_proxy /outpost.goauthentik.io/* http://authentik:9000
  import authentik-proxy
  forward_auth http://authentik:9000 {
    uri /outpost.goauthentik.io/auth/caddy
    copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid X-Authentik-Jwt X-Authentik-Meta-Jwks X-Authentik-Meta-Outpost X-Authentik-Meta-Provider X-Authentik-Meta-App X-Authentik-Meta-Version
    trusted_proxies private_ranges
  }
  reverse_proxy http://containerip:80   # code-server(/) + webmanager(/manager) 전부 이 한 줄로 커버됩니다 - 컨테이너 안 nginx가 라우팅합니다
}
```

단, `/manifest.json` 와 정적 아이콘 (유저에 의해 위치가 변경될 수도 있는) 는 인증 없이 공개적으로 노출되어있어야 안드로이드에서 PWA 앱이 빌드될 수 있습니다. 이는 안드로이드 크롬 또는 설치 가능 apk 가 생성되는 PWA를 지원하는 브라우저는 실제 apk를 브라우저의 자사 서버(구글 또는 삼성 등)에서 빌드하고 사이닝하므로 해당 서버에서 접근 가능해야하기 때문입니다.

따라서 아주 잠시동안 인증을 제거하고 설치 후 다시 인증을 설정하는것을 추천드립니다. 가능한 경우 인증을 제거할 때 api 는 차단하여도 좋습니다.

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

자세한 내용은 [docs/tips/adb.md](docs/tips/adb.md)를 확인하세요.

## 클립보드 복사 (xclip, wl-copy)

브라우저 기반 터미널이기 때문에 OSC 52 이스케이프 시퀀스로는 클립보드 복사가 되지 않는 경우가 있습니다 (예: Claude Code 등 터미널 프로그램의 클립보드 복사 기능). 이를 위해 `xclip`, `wl-copy` 명령을 흉내내는 셸 스크립트가 `bin/` 에 포함되어 PATH에 제공됩니다. stdin (또는 wl-copy 의 경우 인자로 전달된 텍스트)을 받아 `code-server -c` (브라우저의 Clipboard API 호출)로 전달하는 방식으로 동작합니다. 대부분의 프로그램은 `xclip`/`wl-copy` 바이너리 존재 여부로 클립보드 지원을 판단하므로, 이 스크립트만으로 복사 기능이 자동으로 활성화됩니다. 단, 클립보드 읽기(paste, `xclip -o`)는 지원하지 않습니다.

## Discord presence

vscord 확장으로 Discord Rich Presence를 연동하고, ssh 소켓 포워딩으로 로컬 디스코드 클라이언트와 연결하는 방법입니다.

자세한 내용은 [docs/tips/discord-presence.md](docs/tips/discord-presence.md)를 확인하세요.

## Docker in Docker (dind)

`code-docker-dind` 서비스로 redis, postgres 등 개발용 컨테이너를 code-docker 안에서 바로 `docker run`으로 띄울 수 있습니다.

자세한 내용은 [docs/tips/dind.md](docs/tips/dind.md)를 확인하세요.

## 환경 변수 설정 (.env)

`PWA_NAME`, `TZ`, `LANG`, 마운트할 볼륨 경로(`HOME_VOLUME`/`SSHD_VOLUME`/`DIND_VOLUME`), tailscale 관련 값, 로그 상세도 등 `docker-compose.yml`이 읽는 값들은 모두 `example-env`에 설명과 함께 정리되어 있습니다. `example-env`를 `.env`로 복사한 뒤 필요한 값만 주석을 풀어 쓰세요 - 전부 합리적인 기본값이 있어 이 파일이 없어도 정상 동작합니다. 값을 바꾼 뒤에는 `docker compose up -d`로 컨테이너를 재생성해야 반영됩니다.

```sh
cp example-env .env
```

## 여러 code-docker 인스턴스 사용

여러 인스턴스 구동 시 container_name 이 겹칠 수 있습니다. `.env`에 `PREFIX`를 적절히 설정해주면 해결됩니다 (기본적으로 `${PREFIX:-}`를 붙여서 `docker-compose.yml`을 제공합니다).

## tailscale 연결

code-docker 가 고유한 tailscale IP를 가지도록 하여, ssh/adb 를 위해 별도로 포트를 열거나 `ssh -R` 로 소켓을 전송하지 않고도 tailnet 안 어디서든 code-docker 에 접근하거나, 반대로 code-docker 에서 다른 tailnet 기기의 포트를 가져올 수 있습니다.

자세한 내용은 [docs/tailscale.md](docs/tailscale.md)를 확인하세요.

- [켜고 끄기](docs/tailscale.md#켜고-끄기)
- [최초 로그인과 상태 배너](docs/tailscale.md#최초-로그인과-상태-배너)
- [자체 호스팅 로그인 서버 (Headscale)](docs/tailscale.md#자체-호스팅-로그인-서버-headscale)
- [포트 가져오기 (forwards)](docs/tailscale.md#포트-가져오기-forwards)
- [포트 내보내기 (publish)](docs/tailscale.md#포트-내보내기-publish)
- [보안: tailnet ACL 설정](docs/tailscale.md#보안-tailnet-acl-설정) — 놓치기 쉬운 필수 설정입니다

## webmanager (관리자 패널)

80번 포트의 code-server 와 같은 origin, `/manager` 경로에 브라우저 관리자 패널이 함께 떠 있습니다 (Go 백엔드 + React 프론트엔드, `webmanager/` 폴더에서 개발됩니다) — 컨테이너 안 nginx가 `/manager`를 webmanager로, 나머지를 code-server로 라우팅해줍니다. 별도 포트로 직접 열고 싶다면(예: nginx를 거치지 않고 붙고 싶은 경우) `.env.webmanager`의 `WEBMANAGER_ADDR`를 `:81`로 바꾸고 `docker-compose.yml`의 주석 처리된 `81:81` 매핑을 되살리세요.

자세한 내용(각 탭 설명, 비밀번호 게이트, 보안 주의사항)은 [docs/webmanager.md](docs/webmanager.md)를 확인하세요.

- [Supervisor](docs/webmanager.md#supervisor)
- [SSH Keys](docs/webmanager.md#ssh-keys)
- [Git Config](docs/webmanager.md#git-config)
- [Tailscale](docs/webmanager.md#tailscale)
- [Logs](docs/webmanager.md#logs)
- [Task Manager](docs/webmanager.md#task-manager)
- [Claude Code](docs/webmanager.md#claude-code)
- [Code Extensions](docs/webmanager.md#code-extensions)
- [Projects](docs/webmanager.md#projects)
- [mise](docs/webmanager.md#mise)
- [Terminal](docs/webmanager.md#terminal)
- [Files](docs/webmanager.md#files)
- [Docker/dind 관리](docs/webmanager.md#dockerdind-관리)
- [비밀번호 게이트](docs/webmanager.md#비밀번호-게이트) — 기본 꺼짐, 외부 노출 시 설정 강력 권장

# 빌드 커스터마이징

각각의 config 폴더 안 파일들은 \*.default.\* 를 복사하여 \*.override.\* 로 바꾸어 원하는대로 작성할 수 있습니다. 예를들면 build.default.sh 를 build.override.sh 로 복사하여 원하는대로 변경할 수 있습니다. 단, sh 파일들은 꼭 `chmod u+x` 를 적용하여 실행가능한 파일로 만들어야합니다. 각 override 파일은 편집 후, 컨테이너 재빌드가 필요합니다 (`docker compose build 컨테이너명 && docker compose up -d`).

전체 파일 목록과 각 파일의 역할은 [docs/build-customization.md](docs/build-customization.md)에 정리되어 있습니다:

- **빌드**: `build.*.sh`
- **code-server**: `code-service.*.sh`, `code-config.*.yaml`, `code-env.*.sh`, `code-runner.*.sh`, `recommendations.*.yaml`, `shell.*`
- **tailscale**: `tailscale-service.*.sh`, `tailscale-forward.*.sh`, `tailscale-status.*.sh`, `tailscale-config.*.yaml`
- **webmanager**: `webmanager.*.sh`, `supervisor-metadata.*.yaml`, `example-env.webmanager`(런타임 환경변수 템플릿, 저장소 루트)
- **기타**: `supervisord.*.conf`, `supervisord/*.conf`, `user-init.*.sh`, `sshd-service.*.sh`, `code-patch.*.sh`, `code-patch/`, `vector-service.*.sh`(`VECTOR_LOG_LEVEL`로 vector 자체 진단 로그 상세도 조절), `vector.*.toml`(`TAILSCALE_LOG_LEVEL`로 유독 시끄러운 tailscaled 로그를 로그인/상태전환/fatal 에러만 남도록 필터링), `nginx-service.*.sh`, `nginx.*.conf`(code-server `/` + webmanager `/manager` 단일 origin 라우팅, `NGINX_LOG_LEVEL`로 access_log 상세도 조절)

# 코드 서버 패치

폰트나 css, js 를 커스텀으로 로드하고 싶은 경우 `/code/.server/patch` 폴더를 만들어 안에 css, js 를 만들어줄 수 있습니다. PWA 이름/아이콘, 타이틀바 아이콘 변경 방법도 포함됩니다.

자세한 내용은 [docs/code-server-patch.md](docs/code-server-patch.md)를 확인하세요.
