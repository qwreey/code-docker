# code-docker

![image](https://github.com/user-attachments/assets/ebd212a9-e620-46c4-9cd0-dbcbf1a55b69)

개인적인 목적의 code-server 도커 이미지입니다. `qwreey/qwreey-fish` 와 통합되어있습니다. mise 환경이 제공되며, `mise use -g node@26.4.0 uv` 등의 명령으로 원하는 개발 도구를 빌드 타임이 아닌 런타임에 설치할 수 있습니다. 또한 빌드 타임에 yay 를 통한 aur 설치나 pacman 을 통한 공식 arch 패키지를 설치할 수 있습니다.

 - GCC: arch linux 의 base-devel, cmake 패키지가 제공됩니다.
 - openssh: arch linux 의 openssh 패키지가 제공됩니다. 또한 호스트키가 미리 설정됩니다. code-server 안에서 /code/.ssh 폴더를 생성하고 authorized_keys 를 적절하게 설정하면 됩니다.

필요한 경우 시스템 패키지를 임의로 추가할 수 있습니다 [빌드 커스터마이징](docs/build-customization.md)을 확인하세요

## 문서화

문서는 `docs` 폴더에 배치됩니다. 처음 설치하는 경우 [index.md](docs/index.md) 를 확인하세요.
