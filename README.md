# code-docker

![image](https://github.com/user-attachments/assets/ebd212a9-e620-46c4-9cd0-dbcbf1a55b69)

개인적인 목적의 code-server 도커 이미지입니다. qwreey/qwreey-fish 와 통합되어있습니다. mise 환경이 제공되며, `mise use -g node@26.4.0 uv` 등의 명령으로 원하는 개발 도구를 빌드 타임이 아닌 런타임에 설치할 수 있습니다.

 - GCC: arch linux 의 base-devel, cmake 패키지가 제공됩니다.
 - openssh: arch linux 의 openssh 패키지가 제공됩니다. 또한 호스트키가 미리 설정됩니다. code-server 안에서 /code/.ssh 폴더를 생성하고 authorized_keys 를 적절하게 설정하면 됩니다.

필요한 경우 시스템 패키지를 임의로 추가할 수 있습니다 아래 커스터마이징을 확인하세요

# 기본 사용법

먼저 이 레포지토리를 적당한 폴더에 클론해야합니다. 아래 명령을 기호에 맞추어 수행하세요.
```sh
mkdir -p ~/code-docker/builds
git clone --recurse-submodules https://github.com/qwreey/code-docker.git ~/code-docker/builds/code-docker
cd ~/code-docker
```

그런 다음 아래의 내용을 가진 `docker-compose.yml` 파일을 생성하세요
```yaml
services:
  code-docker:
    container_name: code-docker
    hostname: code-docker
    restart: unless-stopped
    build: ./builds/code-docker
    volumes:
      - ./yaeji-code:/code
      - ./yaeji-code/.sshd:/etc/ssh
    environment:
      # PWA_NAME: "qwreey-code"
      # 옵션과 패치 방법은 아래를 확인하세요
	# 80 http 포트를 리버스 프록시에 물려 외부에 노출하거나
	# 직접 노출하세요, *단 보안 설정에 유의하세요, 가능한 리버스 프록시와*
	# *forward proxy auth 를 적용하는것이 좋습니다, 이를 위해 caddy 와 같은*
	# *웹서버를 사용하세요*
	# ports:
	#   - "8080:80"
```
이제 `docker compose build` 를 수행하고 잘 빌드가 되는지 확인합니다.
만약 빌드에 성공했다면 `docker compose up -d` 를 수행하세요.
잘 구동된다면 성공입니다!
> Note: 시스템 패키지 업데이트를 위해 주기적으로 build 와 up 을 다시 수행해주세요.
> Note: code-docker 업데이트를 수행하려면 `git -C builds/code-docker pull origin master --recurse-submodules` 를 수행하세요

# 환경 변수 재로드

만약 mise 의 global 이 달라졌으며, 이를 code-server 에 적용하고 싶다면 code-server 터미널에 `restart` 를 입력하세요. 이렇게 하면 supervisord 의 code-server 서비스가 재시작됩니다.

# 커스터마이징

각각의 config 폴더 안 파일들은 \*.default.\* 를 복사하여 \*.override.\* 로 바꾸어 원하는대로 작성할 수 있습니다. 예를들면 build.default.sh 를 build.override.sh 로 복사하여 원하는대로 변경할 수 있습니다.
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

유저 홈폴더 (/code) 가 처음 생성될 때 수행됩니다. 모든 동작은 /code 안에서 행해야합니다. 그렇지 않으면 컨테이너가 꺼질 때 작업이 저장되지 않습니다.

여기에서 fish 셸의 설정이 초기화됩니다. 만약 fish 이외의 다른 셸의 설정을 초기화 시키고 싶은 경우 덮어써야합니다.

## shell.\*

`chsh` 명령을 통해 `root` 유저의 셸을 설정할 때 사용할 셸 바이너리의 path 를 가르킵니다. 기본적으로 `/bin/fish` 이지만, `/bin/bash` 또는 `/bin/zsh` 등으로 바꾸는데 사용할 수 있습니다.

## supervisord/\*.conf

supervisord 에 원하는 프로그램을 서비스로 등록하고 싶을 때 사용할 수 있습니다. 기본적으로 `supervisord.default` 의 `include` 부분에 의해서 임포트 됩니다. [파일 포멧에 관해서는 supervisord 의 공식 문서 program 부분](https://supervisord.org/configuration.html#program-x-section-settings)을 확인하세요

# adb 연결

먼저 컨테이너 빌드 상 `android-tools` 가 설치되도록 `build` 스크립트 파일을 편집해주어야합니다.

로컬 데스크탑/랩탑에서 adb 서버를 실행해야합니다. 이를 위해 로컬에서 `adb start-server`를 수행하세요. 반대로 대상 code-docker는 adb 서버를 실행중이지 않아야합니다. 이를 위해 code-docker 에서 `adb kill-server`를 수행하세요

그런 다음 adb 소켓을 code-docker에 연결해야합니다. 이는 방법이 크게 2개 정도 존재합니다

1. ssh 를 통해 소켓을 전송합니다.
`ssh -R 5037:localhost:5037 code -TN` 를 로컬에서 수행하여 로컬 adb 소켓을 code-docker에 연결해줍니다.

2. 환경 변수를 설정하고, 연결 가능하도록 네트워크를 조정
code-docker의 요청이 나가는 네트워크를 잘 구성했다면, 호스트 시스템의 tailscale ip 등의 서브넷으로도 요청을 전송할 수 있습니다. 따라서 환경 변수로써 `ANDROID_ADB_SERVER_ADDRESS` 와 `ANDROID_ADB_SERVER_PORT` 를 적절한 tailscale ip, private ip로 설정하면 항상 원하는 기기의 adb 서버를 사용하게 됩니다.

두 작업 중 하나를 수행하고 나면 code-docker에서 `adb devices`를 수행하면 연결된 장치가 보일것입니다. 이 상태에서 react native metro builder 나 gradle 등으로 장치에 설치 테스트를 수행하면 잘 작동하게 됩니다.

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

patch 디렉터리에 `icons/pwa-icon-512.png` 와 `icons/pwa-icon-192.png` 를 크기에 맞게 생성하세요.

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
이미지 추가 예정
