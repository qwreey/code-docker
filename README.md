# code-docker

개인적인 목적의 code-server 도커 이미지입니다. qwreey/zsh 와 통합되어있습니다. 아래의 툴킷이 제공됩니다.

 - GCC: arch linux 의 build-essential, cmake 가 제공됩니다.
 - rust (rustup): qwreey/zsh 가 제공하는 그대로 제공됩니다.
 - nodejs (fnvm): qwreey/zsh 가 제공하는 그대로 제공됩니다.
 - python (pyenv): qwreey/zsh 가 제공하는 그대로 제공됩니다.

기타 패키지: gdu btop bash zsh

# 커스터마이징

각각의 config 폴더 안 파일들은 -default 를 복사하여 -override 로 바꾸어 원하는대로 작성할 수 있습니다. 예를들면 package-default.sh 를 package-override.sh 로 복사하여 원하는대로 변경할 수 있습니다.