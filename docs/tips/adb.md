# adb 연결

먼저 컨테이너 빌드 상 `android-tools` 가 설치되도록 `build` 스크립트 파일을 편집해주어야합니다. [빌드 커스터마이징](../build-customization.md)의 `build.*.sh` 항목을 확인하세요.

로컬 데스크탑/랩탑에서 adb 서버를 실행해야합니다. 이를 위해 로컬에서 `adb start-server`를 수행하세요. 반대로 대상 code-docker는 adb 서버를 실행중이지 않아야합니다. 이를 위해 code-docker 에서 `adb kill-server`를 수행하세요

그런 다음 adb 소켓을 code-docker에 연결해야합니다. 이는 방법이 크게 2개 정도 존재합니다

## 1. ssh를 통해 소켓을 전송

`ssh -R 5037:localhost:5037 code -TN` 를 로컬에서 수행하여 로컬 adb 소켓을 code-docker에 연결해줍니다. 여기서 `code`는 [ssh 연결](../index.md#ssh-연결) 절에서 설정한 `~/.ssh/config`의 `Host code` 별칭입니다 - 다른 이름으로 설정했다면 그 이름을 그대로 쓰세요.

이것을 자동화 하기 위해 `autossh` 등의 도구를 사용하는것을 고려하세요. 이를 로컬 데스크탑 환경의 autolaunch 또는 service 요소로 등록하면 지속적으로 사용가능합니다.

## 2. 환경 변수를 설정하고, 연결 가능하도록 네트워크를 조정

code-docker의 요청이 나가는 네트워크를 잘 구성했다면, 호스트 시스템의 tailscale ip 등의 서브넷으로도 요청을 전송할 수 있습니다. 따라서 환경 변수로써 `ANDROID_ADB_SERVER_ADDRESS` 와 `ANDROID_ADB_SERVER_PORT` 를 적절한 tailscale ip, private ip로 설정하면 항상 원하는 기기의 adb 서버를 사용하게 됩니다.

가장 간단한 방법은 [router 문서의 forwards 설정](../router.md#설정-파일-forwards--publish)입니다 - 그 방식대로 원하는 기기의 5037 포트(adb 서버)를 가져오면, `ANDROID_ADB_SERVER_ADDRESS=forward` / `ANDROID_ADB_SERVER_PORT=5037` 로 설정하는 것만으로 항상 그 기기의 adb 서버를 쓰게 됩니다.

## 확인 & 흔한 문제

두 작업 중 하나를 수행하고 나면 code-docker에서 `adb devices`를 수행하면 연결된 장치가 보일것입니다. 이 상태에서 react native metro builder 나 gradle 등으로 장치에 설치 테스트를 수행하면 잘 작동하게 됩니다.

- 기기가 안 보이면: 로컬에서 `adb kill-server`를 하지 않아 로컬 adb 서버가 소켓을 계속 물고 있는 건 아닌지 확인하세요.
- `adb devices`에 "unauthorized"로 뜨면: 기기 쪽에서 USB 디버깅 허용 팝업을 확인/수락했는지 확인하세요.
