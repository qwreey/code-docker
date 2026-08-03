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
  reverse_proxy http://containerip:port
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

먼저 컨테이너 빌드 상 `android-tools` 가 설치되도록 `build` 스크립트 파일을 편집해주어야합니다. 아래쪽 [빌드 커스터마이징](#빌드-커스터마이징)을 확인하세요

로컬 데스크탑/랩탑에서 adb 서버를 실행해야합니다. 이를 위해 로컬에서 `adb start-server`를 수행하세요. 반대로 대상 code-docker는 adb 서버를 실행중이지 않아야합니다. 이를 위해 code-docker 에서 `adb kill-server`를 수행하세요

그런 다음 adb 소켓을 code-docker에 연결해야합니다. 이는 방법이 크게 2개 정도 존재합니다

1. ssh 를 통해 소켓을 전송합니다.
`ssh -R 5037:localhost:5037 code -TN` 를 로컬에서 수행하여 로컬 adb 소켓을 code-docker에 연결해줍니다.
이것을 자동화 하기 위해 `autossh` 등의 도구를 사용하는것을 고려하세요. 이를 로컬 데스크탑 환경의 autolaunch 또는 service 요소로 등록하면 지속적으로 사용가능합니다.

2. 환경 변수를 설정하고, 연결 가능하도록 네트워크를 조정
code-docker의 요청이 나가는 네트워크를 잘 구성했다면, 호스트 시스템의 tailscale ip 등의 서브넷으로도 요청을 전송할 수 있습니다. 따라서 환경 변수로써 `ANDROID_ADB_SERVER_ADDRESS` 와 `ANDROID_ADB_SERVER_PORT` 를 적절한 tailscale ip, private ip로 설정하면 항상 원하는 기기의 adb 서버를 사용하게 됩니다.
또한 아래의 [tailscale 연결](#tailscale-연결)을 더 확인해보세요

두 작업 중 하나를 수행하고 나면 code-docker에서 `adb devices`를 수행하면 연결된 장치가 보일것입니다. 이 상태에서 react native metro builder 나 gradle 등으로 장치에 설치 테스트를 수행하면 잘 작동하게 됩니다.

## 클립보드 복사 (xclip, wl-copy)

브라우저 기반 터미널이기 때문에 OSC 52 이스케이프 시퀀스로는 클립보드 복사가 되지 않는 경우가 있습니다 (예: Claude Code 등 터미널 프로그램의 클립보드 복사 기능). 이를 위해 `xclip`, `wl-copy` 명령을 흉내내는 셸 스크립트가 `bin/` 에 포함되어 PATH에 제공됩니다. stdin (또는 wl-copy 의 경우 인자로 전달된 텍스트)을 받아 `code-server -c` (브라우저의 Clipboard API 호출)로 전달하는 방식으로 동작합니다. 대부분의 프로그램은 `xclip`/`wl-copy` 바이너리 존재 여부로 클립보드 지원을 판단하므로, 이 스크립트만으로 복사 기능이 자동으로 활성화됩니다. 단, 클립보드 읽기(paste, `xclip -o`)는 지원하지 않습니다.

## Discord presence

기본적으로 [LeonardSSH.vscord](https://open-vsx.org/vscode/item?itemName=LeonardSSH.vscord) 확장 사용을 권장합니다. 사용 가능함이 확인되었으며, `"vscord.app.privacyMode.enable": true,` 를 통해 민감 정보를 바꾸거나 포멧을 바꾸는 등 설정이 쉽습니다.

디스코드는 unix 소켓을 `$XDG_RUNTIME_DIR` 에 노출시킵니다. 따라서 해당 소켓을
`ssh -R /run/xdg/discord-ipc-0:$XDG_RUNTIME_DIR/discord-ipc-0 code` 형태로 전송하면 작동하게 됩니다.
이것을 자동화 하기 위해 `autossh` 등의 도구를 사용하는것을 고려하세요. 이를 로컬 데스크탑 환경의 autolaunch 또는 service 요소로 등록하면 지속적으로 사용가능합니다.

## Docker in Docker (dind)

편의를 위해 `code-docker-dind` (`docker:dind`) 서비스가 함께 제공됩니다. redis, postgres 등 개발에 필요한 컨테이너를 code-docker 안에서 `docker run ...` 명령으로 바로 생성해 사용할 수 있습니다. `DOCKER_HOST` 환경변수가 이 dind 데몬을 가리키도록 설정되어있어, code-docker 안에서 docker cli 로 생성한 컨테이너는 실제로는 `code-docker-dind` 컨테이너 안에서 동작합니다.

dind 로 생성된 컨테이너는 `code-docker-internal` 네트워크에 묶여 code-docker 에서 접근 가능합니다. 단, 컨테이너가 동작하는곳은 어디까지나 `code-docker-dind` 컨테이너이므로, 포트를 publish 하여 컨테이너를 만든 뒤에는 `localhost` 가 아닌 `dind` 호스트네임으로 접속해야합니다 (`code-docker-dind` 라는 이름도 있지만 쓰지 마세요, 아래 참고). 예를들어 `docker run -d --name mypg -p 5432:5432 postgres` 로 생성했다면 `postgres://dind:5432` 로 접근하세요.

<details>
<summary>왜 <code>code-docker-dind</code> 대신 <code>dind</code> 를 써야 하는지</summary>

code-docker 가 `code-docker-external`/`code-docker-internal` 양쪽에 다 붙어있어서, `code-docker-dind` 라는 이름이 두 네트워크 모두에 등록되어있는 탓에 어느 쪽 IP로 해석될지 비결정적입니다 (dind 데몬 자체가 internal 쪽에만 바인드되어있으므로, 잘못 해석되면 연결이 안됩니다). `dind` 는 `code-docker-internal` 에만 등록되는 별도 alias라 항상 올바른 쪽으로 resolve 됩니다.

</details>

`code-docker-dind` 는 `code-docker-external` 에도 연결되어있지만(`docker pull` 을 위해 필요), 데몬 소켓 자체는 `code-docker-internal` 쪽에만 바인드되어있어 그쪽에서는 노출되지 않습니다.

<details>
<summary>기술적으로 어떻게 막혀있는지</summary>

`code-docker-internal` 은 `internal: true` 로 인터넷 경로가 차단되어있어 `docker pull` 이 실패하므로, `code-docker-dind` 는 `code-docker-external` 에도 연결되어있습니다. 다만 dind 데몬 자체는 `script/dind-entrypoint.sh` 를 통해 `code-docker-internal` 쪽 IP에만 바인드되도록 되어있어(스톡 `docker:dind` 이미지의 `--host=tcp://0.0.0.0:2375` 기본 동작을 오버라이드함), 이미지 pull 은 되면서도 소켓 자체는 `code-docker-external` 에서 접근할 수 없습니다.

</details>

dind 쪽에는 `./dind:/var/lib/docker` 볼륨이 마운트되어있어 컨테이너/이미지가 재기동 후에도 유지됩니다.

> 보안 주의: `code-docker-dind` 는 `privileged: true` 로 구동되며, 인증/TLS 없는 평문 tcp 소켓(2375)이 열려있습니다. `code-docker-external` 로부터는 격리되어있지만, `code-docker-internal` 네트워크에 연결된 컨테이너라면 누구든 이 소켓을 통해 특권 컨테이너를 자유롭게 생성할 수 있습니다. 이는 사실상 호스트 커널에 준하는 권한(컨테이너 탈출 포함)을 얻을 수 있다는 뜻이므로, `code-docker-internal` 에는 신뢰할 수 있는 서비스만 연결하고, code-docker 접근 권한 역시 신뢰할 수 없는 사용자에게 주지 마세요.

## 여러 code-docker 인스턴스 사용

여러 인스턴스 구동 시 container_name 이 겹칠 수 있습니다. 기본적으로 `${PREFIX:-}`를 붙여서 `docker-compose.yml`을 제공하므로 `.env` 파일을 만들고 `PREFIX`를 적절히 설정해주면 해결됩니다.

## tailscale 연결

`docker-compose.yml` 의 `TAILSCALE_ENABLED` 를 `"false"` 로 설정하면 tailscale 관련 기능이 전부 꺼집니다 (`tailscaled`/`tailscale-forward` 두 프로그램은 그대로 떠있지만 아무 것도 하지 않습니다). 기본값은 `"true"` 입니다.

code-docker 가 고유한 tailscale IP를 가지도록 하여, ssh/adb 를 위해 별도로 포트를 열거나 `ssh -R` 로 소켓을 전송하지 않고도 tailnet 안 어디서든 code-docker 에 접근하거나, 반대로 code-docker 에서 다른 tailnet 기기(예: 랩탑의 adb 서버)의 포트를 가져올 수 있습니다. `NET_ADMIN`/커널 tun 디바이스 없이 tailscaled 의 userspace networking 모드만으로 동작합니다.

최초 실행 시 `docker compose logs -f code-docker` 로 로그를 확인하면 `tailscaled` 프로그램 쪽에 인증 URL이 출력됩니다. 이 URL을 브라우저로 한 번 열어 로그인하면 됩니다 (auth key 대신 인터랙티브 로그인 방식). 로그인 상태는 `/code/.tailscale/state` 에 영속되므로 컨테이너를 재생성해도 다시 로그인할 필요가 없습니다.

로그를 뒤질 필요 없이, code-server 화면 자체에도 로그인이 필요할 때 우측 상단에 배너로 뜹니다 (URL, 현재 상태 문자열까지 그대로 표시됩니다). 로그인이 완료되면 별도로 "Tailscale connected" 토스트도 뜹니다. 이미 브라우저 알림 권한을 허용해둔 상태라면 OS 알림도 함께 뜹니다. `code-patch` 가 기본으로 심어주는 `/code/.server/patch/tailscale-notify.js`(폴링 + 표시할 내용) 와 `/code/.server/patch/cd-dialog.js`(배너/토스트/알림을 그리는 재사용 가능한 `window.CDDialog` 모듈) 두 파일로 구성되며, 아래 [code-patch/](#code-patch) 를 통해 관리됩니다 - `patch/*.js` 자체는 [코드 서버 패치](#코드-서버-패치)와 동일하게 동작하는 파일이라 직접 편집/교체 가능합니다.

기본적으로 공식 tailscale.com 컨트롤 서버에 로그인합니다. Headscale 등 자체 호스팅 서버를 쓰고싶다면 `docker-compose.yml` 의 `TAILSCALE_LOGIN_SERVER` 환경변수를 원하는 URL로 설정하세요 (`tailscale up --login-server=` 로 전달됩니다). 이미 로그인된 상태에서 이 값을 바꾼 경우, `/code/.tailscale/state` 를 지우고 컨테이너를 재시작해야 새 서버로 다시 로그인합니다.

수신/발신 설정은 `/code/.tailscale/config.yaml` 을 편집합니다 (최초 실행 시 기본값이 자동 생성됩니다).

```yaml
forwards:
  - name: adb                    # 로그/디버깅용 이름표
    local_port: 5037
    remote_host: laptop          # tailscale hostname 또는 IP
    remote_port: 5037

publish:
  - name: dev-server
    tailscale_port: 80
    local_port: 3000
    mode: tcp                    # tcp | tls-terminated-tcp
```

- `forwards`: 다른 tailnet 기기의 포트를 code-docker 로 가져옵니다. 컨테이너 안에서는 `forward` 라는 hostname 으로 접근하세요 (예: adb 는 `ANDROID_ADB_SERVER_ADDRESS=forward` — 위 [adb 연결](#adb-연결) 절의 환경 변수 방식과 동일한 패턴, 기존 `ssh -R` 방식의 대안입니다).
- `publish`: code-docker 의 로컬 포트를 tailscale IP에 명시적으로 게시합니다 (포트 리매핑, 또는 `mode: tls-terminated-tcp` 로 무료 HTTPS 종단). 게시하려는 서비스는 `0.0.0.0`/`localhost` 가 아니라 `private` hostname(자기 자신의 tailscale용 전용 IP)에 bind 되어 있어야 합니다.
- 편집 후에는 `forward-reload` 명령으로 반영합니다 (`tailscale-forward` 서비스만 재시작하며, 로그인 세션은 그대로 유지됩니다).

> **주의: sshd(22), code-server(80), webmanager(81)는 `config.yaml`에 없어도 항상 tailnet 에 자동 노출됩니다.** tailscaled 는 `tailscale serve` 규칙이 없는 포트도 같은 번호로 `127.0.0.1`/`0.0.0.0` 에 떠있는 서비스에 자동으로 연결해주기 때문입니다 — 이 세 서비스는 전부 `0.0.0.0` 에 바인드되어 있어서(sshd/code-server는 호스트 포트 퍼블리시 때문에, webmanager는 바인드 주소 전략이 아직 미정이라) 이 자동 노출을 피할 방법이 없습니다. `code-config.default.yaml` 은 `auth: none` 이고 webmanager는 아예 자체 로그인이 없으므로(SSH 키/git credential 을 다루는 만큼 code-server 보다 더 민감), code-docker 가 tailnet 에 들어가는 순간 인증 없이 두 서비스에 접근 가능한 사람이 tailnet 전체로 넓어집니다.
>
> **그래서 tailnet 관리 콘솔(ACL)에서 code-docker 태그로 접근 가능한 포트를 반드시 제한하세요.** 예:
> ```json
> {
>   "tagOwners": { "tag:code-docker": ["autogroup:admin"] },
>   "grants": [
>     { "src": ["autogroup:member"], "dst": ["tag:code-docker"], "ip": ["tcp:22", "tcp:80", "tcp:81"] }
>   ]
> }
> ```
> 이게 없으면 sshd/code-server/webmanager 는 항상 tailnet 전체에 열려있는 상태입니다.
>
> 반대로 `forwards`/`publish` 는 이런 자동 노출에 걸리지 않도록 이미 전용 네트워크의 자기 자신 IP에만 바인드되어 있어서 안전합니다 — private 하게 유지하고 싶은, 직접 띄운 서비스(dev 서버 등)는 `0.0.0.0`/`localhost` 대신 `private` 에 bind 하고 필요할 때만 `publish:` 에 추가하세요. `forwards:` 로 가져온 것들은 `forward` hostname 으로만 접근 가능하니 혼동하지 마세요.

## webmanager (관리자 패널)

80번 포트의 code-server 와 별개로, `81`번 포트에 브라우저 관리자 패널이 함께 떠 있습니다 (Go
백엔드 + React 프론트엔드, `webmanager/` 폴더에서 개발됩니다). 구현된 기능:

- **Supervisor**: supervisord 프로그램 목록 조회 및 start/stop/restart, 표준출력/표준에러 로그 확인.
  프로그램별로 특정 컨트롤을 비활성화(설명 노트와 함께)할 수 있는 메타데이터 지원(아래
  `supervisor-metadata.*.yaml` 참고 — `vector`는 기본적으로 로그 보기가 꺼져 있습니다), 프로그램의
  PID를 루트로 한 자식 프로세스 트리 펼쳐보기
- **SSH Keys**: `/code/.ssh/authorized_keys` 목록 조회/추가/삭제
- **Git Config**: `/code/.gitconfig` 의 user.name/email, 커밋 사이닝(SSH 키 또는 GPG, GPG 키
  자체 생성/조회/삭제 포함), 호스트별 SSH 키(ed25519 자동 생성), HTTPS credential store
  (`~/.git-credentials`, 평문 저장), `~/.ssh/known_hosts` 관리, `git lfs install` 실행,
  `.gitconfig` 원본 직접 편집(저장 전 문법 검증)
- **Tailscale**: `/code/.tailscale/config.yaml`의 `forwards`/`publish` 항목 조회/추가/삭제
  (저장 시 `tailscale-forward` 자동 재시작 — `forward-reload`와 동일 효과). 로그인
  상태/URL은 다루지 않음 — 아래 tailscale 배너를 그대로 씁니다
- **Logs**: 프로그램별 구조화 로그를 앱/레벨/시간 범위(존재하는 로그 기준으로 자동
  clamp됨)로 필터링해서 조회, 커서 기반 페이지네이션, 실시간 새로고침(신규 항목 누적)
  (아래 vector 문단 참고) — 로그에 시크릿이 노출될 수 있어 이 탭 전체가 비밀번호
  게이트 대상입니다(아래 보안 문단 참고)
- **Task Manager**(구 "Processes"): "성능"/"프로세스" 두 서브탭. 성능 탭은 호스트 전체
  기준 코어별 CPU 사용률 히트맵, 메모리 구성요소별(캐시/버퍼/사용/여유) 분해(cgroup
  제한과 호스트 물리 총량을 나란히), 가능하면 클럭/온도, 최근 10분 히스토리 그래프.
  프로세스 탭은 리스트/트리 뷰 전환, 상태 필터, 이름/커맨드 퍼지 검색(일치 부분
  강조), 페이지네이션, 리스닝 포트별 점유 프로세스 조회/종료(SIGTERM/SIGKILL) —
  `btop`을 안 열어도 다 됩니다
- **Claude Code**: 설치 여부 감지, 로그인 상태, 사용 통계(총 세션/오늘·이번 주/최장
  세션, 월간 히트맵, 주간 그래프, 모델별 토큰 사용량), 설치된 Skills/Plugins 목록
- **Code Extensions**: `recommendations.*.yaml`의 추천 code-server 익스텐션 목록을 카테고리별로
  접었다 펼치며 보고 설치, 이미 설치된 익스텐션 전체 목록(기본 접힘), 추천 목록
  표시 여부 토글(기기별 저장)
- **Projects**: `$HOME/Projects` 아래 프로젝트별 용량, `node_modules`/`target` 등
  재생성 가능한 폴더 브레이크다운, 오래된 프로젝트 표시, 최근 편집순 정렬, 프로젝트별
  mise 사용 도구 목록(읽기 전용), 설정된 경우 code-server로 바로 열기 (읽기 전용 —
  삭제 기능은 아직 없음)
- **mise**: 추천 도구 목록을 카테고리별로 접었다 펼치며(기본 접힘) 보고 설치
  (`mise use -g`), 전역으로 설치된 도구 목록/삭제, 환경변수 미리보기(`mise env`) —
  전역 도구를 바꾼 뒤 code-server 통합 터미널에 반영하려면 `restart` 명령이 여전히
  필요합니다
- **Terminal**: 브라우저에서 바로 여는 쉘(xterm.js + WebSocket) — code-server 자체가
  죽었을 때의 최소 복구 수단이자, code-server 세션과 무관하게 dev 서버를 잠깐 띄워두는
  용도. 탭을 닫으면 세션도 즉시 종료됩니다(아직 이름 붙은 영속 세션은 없음). 모바일에서도
  쓸 수 있게 Esc/Ctrl/Alt/Shift/Tab/방향키 온스크린 버튼(커스터마이징 가능)과 색상
  테마(프리셋 10개 + 사용자 정의) 지원
- **Files**: `/code` 아래(설정으로 넓힐 수 있음) 파일시스템을 code-server가 지금 열어둔
  프로젝트 폴더에 국한되지 않고 브라우징 — 업로드/다운로드/삭제/이동/복사/이름변경/폴더
  생성/멀티선택, 텍스트 파일은 바로 편집(CodeMirror), 권한/생성·수정 시각 정보 패널

git-lfs 는 `config/build.default.sh`에 포함되어 기본으로 설치됩니다(패키지 설치만 —
저장소별 `git lfs install`은 위 Git Config 탭에서 직접 실행). dind(Docker) 관리는 아직
구현되어있지 않습니다.

> **주의: webmanager는 자체 비밀번호 게이트를 지원합니다(선택 사항, 기본은 꺼짐).**
> `WEBMANAGER_AUTH_PASSWORD_HASH` 환경변수에 argon2id로 해시한 비밀번호를 설정하면
> `/api/auth/unlock`으로 풀기 전까진 접근할 수 없는 라우트가 생깁니다(해제하면 10분간
> 다시 안 물어봄). **해시는 컨테이너가 이미 떠 있는 상태에서 아래 명령으로 직접
> 생성합니다**(비밀번호를 두 번 입력받아 오타를 확인하고, 화면엔 안 보이며, 결과로
> `$argon2id$...`로 시작하는 해시 한 줄만 출력됨 — 이 값을 그대로
> `docker-compose.yml`의 `WEBMANAGER_AUTH_PASSWORD_HASH`나 옆의 `.env` 파일에 붙여넣고
> `docker compose up -d`로 다시 올리면 적용됩니다, `restart`로는 새 환경변수가 안
> 먹습니다):
>
> ```sh
> docker compose exec code-docker /etc/code-docker/webmanager/webmanager --hash-password
> ```
>
> 원칙은 **조회(읽기)는 그대로 열어두고, 변경(쓰기)만 게이트** —
> Supervisor의 start/stop/restart, Git Config/Tailscale의 모든 추가·수정·삭제, SSH
> Keys 추가·삭제 등이 여기 해당합니다. 예외로 **Terminal, 파일 탭, Logs, Supervisor의
> 프로그램별 로그 조회는 조회까지 통째로 게이트**됩니다(각각 root 쉘/임의 파일
> 접근/로그 속 시크릿 노출 위험 때문). 값은 반드시 환경변수로만 주입해야 하며(설정
> 파일에 저장하면 컨테이너 안에서 프로세스를 재시작해 우회할 수 있어 일부러 지원하지
> 않습니다), `/etc/environment`에도 같은 이름의 변수가 있으면 조작 가능성으로 보고
> 게이트가 무시됩니다. 설정하지 않으면 이 게이트는 기본적으로 열려 있으므로(다른
> 탭과 동일하게 리버스 프록시 인증에만 의존), 컨테이너 밖에 노출한다면 반드시 설정을
> 권장합니다 — 특히 Terminal(브라우저에서 곧바로 root 쉘)과 파일 탭(임의 파일시스템
> read/write/delete)은 webmanager 안에서 가장 강한 권한을 가진 기능입니다.

각 supervisord program의 표준출력은 이제 `/var/log/<프로그램명>/stdout.log` 로 실제 파일에
회전(rotate)되어 남으며, [vector](https://vector.dev)가 이 파일들을 tail 하여
`[프로그램명] ...` 형태로 라벨링해서 컨테이너 stdout으로 다시 흘려보냅니다 — 따라서
`docker compose logs` 로도 이제 어느 program의 로그인지 구분됩니다(아래 `vector.*.toml`
참고). webmanager의 로그 뷰어(Logs 페이지)도 vector가 함께 쓰는 구조화 로그
(`/code/.vector/logs/*.jsonl`)를 읽어 실제 데이터를 보여줍니다(이전엔 목업 데이터였습니다).

> **주의: webmanager 는 자체 로그인 화면이 없습니다.** code-server 와 마찬가지로 앞단
> 리버스 프록시의 forward-auth 에만 의존하므로, 프록시 설정 없이 81번 포트를 그대로
> 인터넷에 노출하면 안 됩니다 ([보안 (로그인)](#보안-로그인) 절과 동일한 방식으로 프록시를
> 구성하세요). SSH 키/git credential 파일을 직접 다루는 기능이라 code-server 의
> `auth: none` 보다 더 신중한 접근 통제가 필요합니다. **특히 Terminal(브라우저에서
> 곧바로 root 쉘)과 파일(임의 파일시스템 read/write/delete) 탭은 webmanager 안에서
> 가장 강한 권한을 가진 기능**이라 위 "webmanager (관리자 패널)" 절에 설명된 자체
> 비밀번호 게이트(`WEBMANAGER_AUTH_PASSWORD_HASH`, 기본은 꺼짐)를 함께 설정하는 걸
> 강력히 권장합니다.

# 빌드 커스터마이징

각각의 config 폴더 안 파일들은 \*.default.\* 를 복사하여 \*.override.\* 로 바꾸어 원하는대로 작성할 수 있습니다. 예를들면 build.default.sh 를 build.override.sh 로 복사하여 원하는대로 변경할 수 있습니다. 단, sh 파일들은 꼭 `chmod u+x` 를 적용하여 실행가능한 파일로 만들어야합니다.
가급적 업스트림의 변경사항에 따라 필수 바이너리가 따라가도록 하려면 override 파일에서 `/etc/code-docker/build.default.sh` 를 실행하는것을 추천합니다. 다만 원치 않는 경우 하지 않아도 됩니다.
각 override 파일은 편집 후, 컨테이너 재빌드가 필요합니다. `docker compose build 컨테이너명 && docker compose up -d` 를 수행하세요

## build.\*.sh

이미지 build 타임에 수행되는 스크립트입니다. pacman 으로 패키지를 설치하기 위해서 사용됩니다. 또한 이 스크립트는 캐시가 마운트된 상태에서 실행됩니다.

## code-service.\*.sh

code-server 서비스 엔트리포인트입니다. code-server 의 업데이트/설치와 초기 환경설정이 여기에서 이루워집니다. 동작 보장을 위해서 일반적으로 수정하지 말아야합니다. 환경변수를 설정하고 싶은경우 소싱되는 `code-env.*.sh` 를 편집하세요. 또는 실행 방식을 바꾸려면 `code-runner.*.sh` 를 수정하세요. code-server 의 설정은 `code-config.*.yaml` 이 초기값으로 복사됩니다.

## code-config.\*.yaml

유저가 적절한 설정을 가지고 있지 않을 때(일반적으로 초기 설치에) 복사되는 기본 code-server 설정파일입니다. 이미 설정된 경우 /code/.server/config.yaml 를 수정해야합니다.

여기의 각 요소는 /code/.server/code-server/bin/code-server --help 를 통해 확인해볼 수 있습니다. 각각의 인자 `--some=value` 는 `some: value` 로 작성할 수 있습니다.

## recommendations.\*.yaml

webmanager의 "Code Extensions" 탭이 추천 목록으로 보여주는 code-server 익스텐션 목록입니다
(추후 mise 도구 추천 목록도 이 파일에 `mise:` 최상위 키로 추가될 예정). 여러 사용자에게
같은 이미지를 배포하는 경우, 이 파일을 override해서 조직에 맞는 추천 목록으로 완전히
교체할 수 있습니다.

## supervisor-metadata.\*.yaml

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

## code-env.\*.sh

`code-service.*.sh` 가 code-server 를 실행하기전 소싱하는 파일입니다. 일반적으로 환경변수를 설정하는데 사용합니다.

## code-runner.\*.sh

code-server 를 어떻게 수행할지 정의합니다. qwreey/code-server-autoinstall 이 제공하는 start.sh 의 래퍼이며 mise 가 제공하는 툴킷을 code-server 에 환경변수로써 알려주기 위해서 mise env 를 수행합니다.

## supervisord.\*.conf

supervisord 에 사용될 설정파일입니다.

## user-init.\*.sh

유저 홈폴더 (/code) 가 처음 생성될 때 수행되는 작업을 설정합니다. 모든 동작은 /code 안에서 행해야합니다. 그렇지 않으면 컨테이너가 꺼질 때 작업이 저장되지 않습니다. 또한 마이그레이션이 필요한 경우를 위해 이 스크립트는 항상 실행됩니다 - 홈의 업데이트 필요 유무는 직접 구현해야합니다.

여기에서 fish 셸의 설정이 초기화됩니다. 만약 fish 이외의 다른 셸의 설정을 초기화 시키고 싶은 경우 덮어써야합니다.

## sshd-service.\*.sh

sshd 를 설정하고 실행합니다. 기본적으로 `/etc/ssh`는 적절한 마운트가 있어 유지됩니다. 따라서 `user-init` 과 유사하게 작성할 수 있습니다.

## tailscale-service.\*.sh

`tailscaled` 를 설정하고 실행합니다 (userspace networking 모드). 로그인 세션은 `/code/.tailscale/state` 에 영속되므로, `sshd-service.*.sh` 와 유사하게 재작성할 수 있습니다.

## tailscale-forward.\*.sh

`/code/.tailscale/config.yaml` 을 읽어 `forwards`(socat + SOCKS5)/`publish`(`tailscale serve`) 를 구성하는 스크립트입니다. `tailscaled`/`tailscale-status` 와 별도 supervisord program 으로 등록되어 있어, 이 스크립트만 (`forward-reload` 로) 재시작해도 `tailscaled` 의 로그인 세션에는 영향을 주지 않습니다.

## tailscale-status.\*.sh

`tailscale status --json` 를 주기적으로 확인해 로그인 필요 여부/URL을 `/code/.server/patch/tailscale/status.json` 에 기록하는 스크립트입니다 (`tailscale-notify.js` 가 폴링하는 대상). `tailscaled`/`tailscale-forward` 와도 별도 supervisord program 이라, 로그인이나 포워딩 상태와 무관하게 항상 동작합니다.

## tailscale-config.\*.yaml

`/code/.tailscale/config.yaml` 이 아직 없을 때(최초 실행 시) 복사되는 기본값입니다. 이미 생성된 경우 `/code/.tailscale/config.yaml` 을 직접 수정하세요.

## code-patch.\*.sh

`code-patch/` 폴더(아래 참고)의 내용을 `/code/.server/patch/` 로 심는 스크립트입니다. `user-init` 과 마찬가지로 매 부팅마다 항상 실행되지만, `user-init` 과는 별도로 `code-service.*.sh` 에서 (`install.sh` 로 실제 `/code/.server` 가 만들어진 *이후에*) 실행됩니다 - `user-init` 은 fish 설정 등 홈 폴더/셸 초기화를 위한 곳이라, code-server 내부(`/code/.server`)를 다루는 이 로직과는 관심사를 분리했습니다.

## code-patch/

code-docker 자체가 기본으로 제공하는 브라우저 패치들(현재는 tailscale 알림용 `tailscale-notify.js`/`cd-dialog.js`) 을 모아두는 폴더입니다. 이 폴더 안의 `<이름>.default.<확장자>` 파일은 각각 `/code/.server/patch/<이름>.<확장자>` 로 - 이미 그 이름의 파일이 없을 때만 - 복사됩니다 (`code-patch.*.sh` 가 매 부팅마다 확인). 같은 폴더에 `<이름>.override.<확장자>` 를 두면(다른 곳의 `*.override.*` 와 동일하게 gitignore 되어 커밋되지 않음) default 대신 그 파일이 복사됩니다. 이미 유저가 오버라이드해서 쓸 수 있는 파일들이라 폴더 이름에는 "default" 를 붙이지 않았습니다.

한 번 `/code/.server/patch/` 에 복사된 뒤에는 직접 수정해도 다음 부팅에 덮어써지지 않습니다 (다른 [코드 서버 패치](#코드-서버-패치) 파일과 동일). 다만 이후 code-docker 버전에서 해당 `.default.` 파일이 아예 없어지면, 이전에 심어졌던 사본도 함께 삭제됩니다(`/code/.server/.code-patch-manifest` 로 추적).

## shell.\*

`chsh` 명령을 통해 `root` 유저의 셸을 설정할 때 사용할 셸 바이너리의 path 를 가르킵니다. 기본적으로 `/bin/fish` 이지만, `/bin/bash` 또는 `/bin/zsh` 등으로 바꾸는데 사용할 수 있습니다.

## supervisord/\*.conf

supervisord 에 원하는 프로그램을 서비스로 등록하고 싶을 때 사용할 수 있습니다. 기본적으로 `supervisord.default` 의 `include` 부분에 의해서 임포트 됩니다. [파일 포멧에 관해서는 supervisord 의 공식 문서 program 부분](https://supervisord.org/configuration.html#program-x-section-settings)을 확인하세요

## webmanager.\*.sh

webmanager 바이너리를 실행합니다 ([webmanager (관리자 패널)](#webmanager-관리자-패널) 참고).
바이너리와 프론트엔드 정적 파일은 `webmanager/backend`, `webmanager/frontend` 를 빌드 타임에
컴파일/빌드하여 `/etc/code-docker/webmanager/` 에 넣어둔 것이라, 이 스크립트에서 바로
편집할 수 있는 부분은 없고 환경변수만 다룹니다 (`WEBMANAGER_ADDR`, `SUPERVISOR_SOCK`,
`SSH_AUTHORIZED_KEYS` 등 — 전체 목록은 `webmanager/backend/README.md` 참고).

## vector-service.\*.sh

`vector` 를 실행합니다. `vector.*.toml` 을 선택해 넘겨주는 것 외에는 `/code/.vector/state`
(체크포인트), `/code/.vector/logs`(구조화 로그) 디렉토리를 미리 만드는 역할만 합니다.

## vector.\*.toml

[vector](https://vector.dev) 설정 파일입니다. 각 supervisord program 의 `stdout_logfile`
(아래 `supervisord.*.conf` 참고)을 `file` source 로 tail 해서, 파일 경로에서 프로그램
이름(`app_name`)을 뽑아내고 메시지 내용으로 대략적인 로그 레벨(`level`)을 추정한 뒤 두 곳으로
내보냅니다 — 라벨링된 형태(`[app_name] message`)로 다시 컨테이너 stdout에 재출력(`console`
sink, `docker compose logs` 에서 프로그램 구분이 되도록 함)하고, 동시에
`/code/.vector/logs/YYYY-MM-DD.jsonl` 로 하루 단위 구조화 로그 파일을 씁니다(`file` sink,
`{"timestamp","app_name","level","message"}` 4개 필드만 담은 JSON 한 줄 — webmanager의 로그
뷰어가 여기서 직접 읽습니다). 로그 레벨은 메시지에 `error`/`warn` 등의 문자열이 포함되는지
보는 대략적인 추정치일 뿐이라 정확한 파싱은 아닙니다. `/code/.vector/logs` 는 별도 보존 기간
정책 없이 계속 쌓이므로 필요하면 직접 정리하세요.

# 코드 서버 패치

폰트나 css, js 를 커스텀으로 로드하고 싶은 경우 `/code/.server/patch` 폴더를 만들어 안에 css, js 를 만들어줄 수 있습니다.

![image](https://github.com/user-attachments/assets/1cd9f7ad-d510-4d89-aa64-15524f68b4c5)

CSS 에서는 에셋을 상대 경로로 불러올 수 있습니다. 폰트를 불러오고싶은 경우 아래와 같은 코드를 작성하세요

```css
@font-face {
	font-family: 'KawaiiMono';
	src: url('./fonts/KawaiiMonoRegular.ttf') format('truetype');
	font-weight: 400;
	font-style: normal;
}
```

> 주의사항: patch 바로 아래에 있는 css, js 만 바로 로드됩니다. patch 안에 폴더를 만들어 파일을 넣는 경우 에셋으로 취급됩니다.

css, js 를 변경한 경우 코드 터미널에서 `restart` 를 입력하고, 윈도우 리로드가 뜰 때 리로드를 해주면 적용된 code-server 를 보실 수 있습니다.

## PWA 이름과 아이콘

앱의 이름은 `PWA_NAME`, `PWA_SHORT_NAME` 환경변수를 변경하여 설정할 수 있습니다. docker-compose.yml 을 편집하세요.

아이콘을 추가하려면 patch 디렉터리에 `icons/pwa-icon-512.png` 와 `icons/pwa-icon-192.png` 를 크기에 맞게 생성하세요.

ffmpeg 를 통해 특정 이미지를 크기를 변경하여 아이콘으로 적용하려면 다음을 수행하세요
```sh
IMAGE=./myimage.png
PATCH_FOLDER=/code/.server/patch

mkdir -p "$PATCH_FOLDER/icons"
ffmpeg -i "$IMAGE" -vf scale=512:512 "$PATCH_FOLDER/icons/pwa-icon-512.png"
ffmpeg -i "$IMAGE" -vf scale=192:192 "$PATCH_FOLDER/icons/pwa-icon-192.png"
```

## window-appicon.{png,webp,jpg,jpeg,gif}

추가적으로, 만약 창 왼쪽 위의 타이틀바 아이콘을 변경하려면 `window-appicon.*` 파일을 patch 디렉터리에 생성하여 원하는 이미지로 변경할 수 있습니다.
