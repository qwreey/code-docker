# Docker in Docker (dind)

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

webmanager의 [Docker/dind 관리 탭](../webmanager.md#dockerdind-관리)에서 컨테이너/이미지 목록, 로그 조회, 시작/정지/삭제도 브라우저에서 바로 할 수 있습니다.
