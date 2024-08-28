# code-docker

개인적인 목적의 code-server 도커 이미지입니다. qwreey/zsh 와 통합되어있습니다. 아래의 툴킷이 제공됩니다.

 - GCC: arch linux 의 base-devel, cmake 가 제공됩니다.
 - rust (rustup): qwreey/zsh 가 제공하는 그대로 제공됩니다.
 - nodejs (fnvm): qwreey/zsh 가 제공하는 그대로 제공됩니다.
 - python (pyenv): qwreey/zsh 가 제공하는 그대로 제공됩니다.

예정:
 - java (javaenv): qwreey/zsh 가 제공하는 그대로 제공됩니다.
 - go (gvm): qwreey/zsh 가 제공하는 그대로 제공됩니다.

기타 패키지: gdu btop bash zsh vim openssh less cloc

# 커스터마이징

각각의 config 폴더 안 파일들은 \*.default.\* 를 복사하여 \*.override.\* 로 바꾸어 원하는대로 작성할 수 있습니다. 예를들면 build.default.sh 를 build.override.sh 로 복사하여 원하는대로 변경할 수 있습니다.

## build.\*.sh

이미지 build 타임에 수행되는 스크립트입니다. pacman 으로 패키지를 설치하기 위해서 사용됩니다. 또한 이 스크립트는 캐시가 마운트된 상태에서 실행됩니다.

## service.\*.sh

code-server 서비스 엔트리포인트입니다. code-server 의 업데이트/설치와 초기 환경설정이 여기에서 이루워집니다. 동작 보장을 위해서 일반적으로 수정하지 말아야합니다. 환경변수를 설정하고 싶은경우 소싱되는 `editor-env.*.sh` 를 편집하세요. 또는 실행 방식을 바꾸려면 `code.*.sh` 를 수정하세요. code-server 의 설정은 `code-config.*.yaml` 이 초기값으로 복사됩니다.

## code-config.\*.yaml

유저가 적절한 설정을 가지고 있지 않을 때(일반적으로 초기 설치에) 복사되는 기본 code-server 설정파일입니다. 이미 설정된 경우 /code/.server/config.yaml 를 수정해야합니다.

여기의 각 요소는 /code/.server/code-server/bin/code-server --help 를 통해 확인해볼 수 있습니다. 각각의 인자 `--some=value` 는 `some: value` 로 작성할 수 있습니다.

## editor-env.\*.sh

`service.*.sh` 가 code-server 를 실행하기전 소싱하는 파일입니다. 일반적으로 환경변수를 설정하는데 사용합니다.

## code.\*.sh

code-server 를 어떻게 수행할지 정의합니다. qwreey/code-server-autoinstall 이 제공하는 start.sh 의 래퍼이며 qwreey/zsh 가 제공하는 툴킷을 code-server 에 환경변수로써 알려주기 위해서 /code/.zsh/userenv 래퍼를 사용합니다.

## supervisord.\*.conf

supervisord 에 사용될 설정파일입니다.

## user.\*.sh

유저 홈폴더 (/code) 가 처음 생성될 때 수행됩니다. 모든 동작은 /code 안에서 행해야합니다. 그렇지 않으면 컨테이너가 꺼질 때 작업이 저장되지 않습니다.
