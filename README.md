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

두 작업 중 하나를 수행하고 나면 code-docker에서 `adb devices`를 수행하면 연결된 장치가 보일것입니다. 이 상태에서 react native metro builder 나 gradle 등으로 장치에 설치 테스트를 수행하면 잘 작동하게 됩니다.

## 클립보드 복사 (xclip, wl-copy)

브라우저 기반 터미널이기 때문에 OSC 52 이스케이프 시퀀스로는 클립보드 복사가 되지 않는 경우가 있습니다 (예: Claude Code 등 터미널 프로그램의 클립보드 복사 기능). 이를 위해 `xclip`, `wl-copy` 명령을 흉내내는 셸 스크립트가 `bin/` 에 포함되어 PATH에 제공됩니다. stdin (또는 wl-copy 의 경우 인자로 전달된 텍스트)을 받아 `code-server -c` (브라우저의 Clipboard API 호출)로 전달하는 방식으로 동작합니다. 대부분의 프로그램은 `xclip`/`wl-copy` 바이너리 존재 여부로 클립보드 지원을 판단하므로, 이 스크립트만으로 복사 기능이 자동으로 활성화됩니다. 단, 클립보드 읽기(paste, `xclip -o`)는 지원하지 않습니다.

## Discord presence

기본적으로 [LeonardSSH.vscord](https://open-vsx.org/vscode/item?itemName=LeonardSSH.vscord) 확장 사용을 권장합니다. 사용 가능함이 확인되었으며, `"vscord.app.privacyMode.enable": true,` 를 통해 민감 정보를 바꾸거나 포멧을 바꾸는 등 설정이 쉽습니다.

디스코드는 unix 소켓을 `$XDG_RUNTIME_DIR` 에 노출시킵니다. 따라서 해당 소켓을
`ssh -R /run/xdg/discord-ipc-0:$XDG_RUNTIME_DIR/discord-ipc-0 code` 형태로 전송하면 작동하게 됩니다.
이것을 자동화 하기 위해 `autossh` 등의 도구를 사용하는것을 고려하세요. 이를 로컬 데스크탑 환경의 autolaunch 또는 service 요소로 등록하면 지속적으로 사용가능합니다.

# 빌드 커스터마이징

각각의 config 폴더 안 파일들은 \*.default.\* 를 복사하여 \*.override.\* 로 바꾸어 원하는대로 작성할 수 있습니다. 예를들면 build.default.sh 를 build.override.sh 로 복사하여 원하는대로 변경할 수 있습니다. 단, sh 파일들은 꼭 `chmod u+x` 를 적용하여 실행가능한 파일로 만들어야합니다.
각 override 파일은 편집 후, 컨테이너 재빌드가 필요합니다. `docker compose build 컨테이너명 && docker compose up -d` 를 수행하세요

## build.\*.sh

이미지 build 타임에 수행되는 스크립트입니다. pacman 으로 패키지를 설치하기 위해서 사용됩니다. 또한 이 스크립트는 캐시가 마운트된 상태에서 실행됩니다.

## code-service.\*.sh

code-server 서비스 엔트리포인트입니다. code-server 의 업데이트/설치와 초기 환경설정이 여기에서 이루워집니다. 동작 보장을 위해서 일반적으로 수정하지 말아야합니다. 환경변수를 설정하고 싶은경우 소싱되는 `code-env.*.sh` 를 편집하세요. 또는 실행 방식을 바꾸려면 `code-runner.*.sh` 를 수정하세요. code-server 의 설정은 `code-config.*.yaml` 이 초기값으로 복사됩니다.

## code-config.\*.yaml

유저가 적절한 설정을 가지고 있지 않을 때(일반적으로 초기 설치에) 복사되는 기본 code-server 설정파일입니다. 이미 설정된 경우 /code/.server/config.yaml 를 수정해야합니다.

여기의 각 요소는 /code/.server/code-server/bin/code-server --help 를 통해 확인해볼 수 있습니다. 각각의 인자 `--some=value` 는 `some: value` 로 작성할 수 있습니다.

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

## shell.\*

`chsh` 명령을 통해 `root` 유저의 셸을 설정할 때 사용할 셸 바이너리의 path 를 가르킵니다. 기본적으로 `/bin/fish` 이지만, `/bin/bash` 또는 `/bin/zsh` 등으로 바꾸는데 사용할 수 있습니다.

## supervisord/\*.conf

supervisord 에 원하는 프로그램을 서비스로 등록하고 싶을 때 사용할 수 있습니다. 기본적으로 `supervisord.default` 의 `include` 부분에 의해서 임포트 됩니다. [파일 포멧에 관해서는 supervisord 의 공식 문서 program 부분](https://supervisord.org/configuration.html#program-x-section-settings)을 확인하세요

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
