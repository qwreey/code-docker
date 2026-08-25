# Docker in Docker (dind)

편의를 위해 `code-docker-dind` (`docker:dind`) 서비스가 함께 제공됩니다. redis, postgres 등 개발에 필요한 컨테이너를 code-docker 안에서 `docker run ...` 명령으로 바로 생성해 사용할 수 있습니다. `DOCKER_HOST` 환경변수가 이 dind 데몬을 가리키도록 설정되어있어, code-docker 안에서 docker cli 로 생성한 컨테이너는 실제로는 `code-docker-dind` 컨테이너 안에서 동작합니다.

dind 로 생성된 컨테이너는 `code-docker-internal` 네트워크에 묶여 code-docker 에서 접근 가능합니다. 단, 컨테이너가 동작하는곳은 어디까지나 `code-docker-dind` 컨테이너이므로, 포트를 publish 하여 컨테이너를 만든 뒤에는 `localhost` 가 아닌 `dind` 호스트네임으로 접속해야합니다 (`code-docker-dind` 라는 이름도 있지만 쓰지 마세요, 아래 참고). 예를들어 `docker run -d --name mypg -p 5432:5432 postgres` 로 생성했다면 `postgres://dind:5432` 로 접근하세요.

<details>
<summary>왜 <code>code-docker-dind</code> 대신 <code>dind</code> 를 써야 하는지</summary>

기본 상태에서는 code-docker/code-docker-dind 둘 다 `code-docker-internal` 에만 붙어있어서 `code-docker-dind` 라는 이름도 딱 한 네트워크에만 등록되어있으므로 당장은 모호하지 않습니다. 하지만 `code-docker-external` 을 수동으로 다시 붙이는 순간(둘 중 하나에라도) `code-docker-dind` 라는 이름이 두 네트워크 모두에 등록될 수 있어 어느 쪽 IP로 해석될지 비결정적이게 됩니다 (dind 데몬 자체가 internal 쪽에만 바인드되어있으므로, 잘못 해석되면 연결이 안됩니다). `dind` 는 `code-docker-internal` 에만 등록되는 별도 alias라 이 경우에도 항상 올바른 쪽으로 resolve되므로, 상황과 무관하게 `dind` 를 쓰는 것이 안전합니다.

</details>

`code-docker-dind` 는 `code-docker-internal` 에만 연결되어있고, 데몬 소켓도 그 네트워크의 IP에만 바인드되어있어 컨테이너 바깥(인터넷)에서는 노출되지 않습니다. `docker pull` 등 인터넷 접근이 필요한 요청은 `code-docker-router`(egress netgate - [egress-netgate.md](../../router/docs/egress-netgate.md) 참고)를 게이트웨이로 거쳐 나갑니다.

<details>
<summary>기술적으로 어떻게 막혀있는지</summary>

`code-docker-internal` 은 `internal: true` 로 자체적으로는 인터넷 경로가 없으므로, `code-dind/script/dind-entrypoint.sh` 가 기본 게이트웨이를 `code-docker-router` 로 계속 재설정하는 루프를 **자기 자신 안에서** 돌립니다 - `docker pull` 은 이 경로를 통해 나갑니다. `code-docker` 자신은 이런 루프가 없고, 대신 호스트에서 도는 `code-docker-netinit-docker` 에이전트가 컨테이너 밖에서(컨테이너에 `NET_ADMIN`을 주지 않은 채) 라우트를 심어줍니다 - dind는 이미 `privileged: true`라 스스로 라우트를 관리해도 잃을 게 없는 반대 케이스라 이 에이전트를 거칠 필요가 없습니다. dind 데몬 자체는 같은 스크립트가 `code-docker-internal` 쪽 IP에만 바인드하도록 되어있어(스톡 `docker:dind` 이미지의 `--host=tcp://0.0.0.0:2375` 기본 동작을 오버라이드함), `code-docker-dind` 는 `code-docker-external` 에 아예 붙어있지 않으므로 소켓은 인터넷/호스트 어디서도 직접 접근할 수 없습니다.

</details>

dind 쪽에는 `./data/dind:/var/lib/docker` 볼륨이 마운트되어있어 컨테이너/이미지가 재기동 후에도 유지됩니다.

> 보안 주의: `code-docker-dind` 는 `privileged: true` 로 구동되며, 인증/TLS 없는 평문 tcp 소켓(2375)이 열려있습니다. 인터넷/호스트로부터는 격리되어있지만(`code-docker-external` 에 붙어있지 않음), `code-docker-internal` 네트워크에 연결된 컨테이너라면 누구든 이 소켓에 요청을 보낼 수 있습니다. 아래 "요청 단위 제한 (dind-authz)" 절 덕분에 기본값에서는 이 소켓을 통해 생성되는 컨테이너 자체가 특권을 요구할 수 없게 막혀있지만, 그래도 `code-docker-internal` 에는 신뢰할 수 있는 서비스만 연결하고 code-docker 접근 권한을 신뢰할 수 없는 사용자에게 주지 않는 것이 기본 전제입니다.

## 요청 단위 제한 (dind-authz)

`docker-compose.yml`의 `DIND_TARGET` 이 어떤 Dockerfile 스테이지를 dind로 쓸지 고릅니다 (`example-env` 참고):

- `dind` — 보호 없음, 예전 기본 동작 그대로.
- `dind-authz` (**기본값**) — dind 안의 dockerd에 authorization 플러그인(`code-dind/dind-authz/`, 순수 Go 표준 라이브러리로 작성)이 붙어서, 컨테이너 생성 요청에 아래 중 하나라도 포함되면 요청 자체를 거부합니다:
  - `--privileged`
  - `allowed_caps` 허용 목록(기본은 `NET_BIND_SERVICE`만) 밖의 `--cap-add`
  - `--security-opt seccomp=unconfined`/`apparmor=unconfined`/`label=disable`
  - `--pid=host`, `--network=host`, `--ipc=host`, `--cgroupns=host`
  - `--device`, `--device-cgroup-rule`
  - `/code/` 아래가 아닌 경로를 소스로 하는 bind mount (named volume은 영향 없음)
- `dind-authz-remap` — dind-authz에 더해 [userns-remap](#추가-경화-userns-remap-dind-authz-remap)까지 적용. 기본값이 아닙니다 (아래 절 참고).

정책은 이미지에 구운 기본값(`code-dind/config/dind-authz/*.default.json`)과, `DIND_AUTHZ_VOLUME`(기본 `./data/dind-authz`)로 마운트되는 실시간 conf.d 디렉토리를 병합한 결과입니다. **이 디렉토리는 code-docker 어디에도 마운트되지 않습니다** — code-docker 자신이 자기를 제한하는 정책을 고칠 수 있으면 의미가 없기 때문에, 도커 호스트 자체에 파일시스템 접근 권한이 있는 사람만 편집할 수 있습니다. 예를 들어 특정 capability를 추가로 허용하려면:

```json
// ./data/dind-authz/10-my-exception.json (도커 호스트에서 직접 작성)
{ "allowed_caps": { "SYS_PTRACE": true } }
```

파일을 추가/수정한 뒤 `docker compose restart code-docker-dind` 하면 반영됩니다 (재빌드는 필요 없습니다).

`/code/` 아래로만 bind mount를 허용하는 이유는 보안뿐 아니라 실용적인 이유도 있습니다 — dind는 bind mount의 source 경로를 **자기 자신의 파일시스템 기준**으로 해석하므로(code-docker가 아니라), `code-docker-dind`에도 `/code`가 code-docker와 동일한 호스트 경로로 마운트되어 있습니다. 그래서 프로젝트 자신의 `docker-compose.yml`에 있는 `./data:/var/lib/postgresql/data` 같은 흔한 상대경로 마운트도 (프로젝트가 `/code` 아래에 있는 한) 정상적으로 동작합니다.

## 추가 경화: userns-remap (dind-authz-remap)

`DIND_TARGET=dind-authz-remap`으로 설정하면, dind-authz가 막는 요청 목록에 더해 dind 내부 dockerd 자체에 [userns-remap](https://docs.docker.com/engine/security/userns-remap/)이 적용됩니다 — dind가 만드는 컨테이너 안의 UID 0(root)가 호스트에서는 비특권 UID(`dockremap` 유저, 고정 범위 `165536:65536` — `docker:dind` 베이스 이미지가 이미 이 유저/subuid/subgid를 갖고 있어서 별도로 만들 필요가 없었습니다)로 매핑됩니다. dind-authz가 어떤 이유로든(플러그인 버그, CVE-2026-34040류의 authz 우회 등) 뚫리더라도, `--privileged` 요청은 데몬 자체가 독립적으로 한 번 더 거부하게 되는 2중 방어선입니다.

**기본값이 아닙니다 (`DIND_TARGET`을 명시적으로 바꿔야 켜집니다).** 이유:

1. **LXC 등 중첩 가상화 호스트와 궁합이 안 좋을 수 있음.** unprivileged LXC는 보통 호스트 쪽에서 이미 자체 UID remap을 걸고 있어서, 그 위에 dind가 또 한 번 remap을 얹으면 remap이 중첩됩니다 — 이런 조합에서 스토리지 드라이버/권한 문제가 보고된 사례들이 있습니다. 이 저장소는 여러 종류의 호스트에 배포되는 범용 이미지를 지향하므로 기본값으로 켜두면 원인 파악이 어려운 실패로 나타날 수 있습니다.
2. **`/code` 아래 bind mount 쓰기가 기본적으로 막힙니다 — 직접 테스트로 확인한 실제 제약.** `/code`(그리고 그 아래 프로젝트 폴더들)는 보통 `root:root 755`로 되어있는데, remap된 컨테이너의 root는 호스트에서 `dockremap`(UID 165536)일 뿐이라 다른 사용자 소유의 755 디렉토리에는 쓰기 권한이 없습니다. 즉 `dind-authz-remap`을 켜면, redis/postgres 같은 컨테이너가 `-v /code/myproject/pgdata:/var/lib/postgresql/data`로 자기 데이터를 쓰려는 흔한 패턴이 **권한 오류로 그냥 실패**합니다 (실제로 재현해서 확인함). 해결 방법 두 가지:
   - **(권장) bind mount 대신 named volume 사용** — `-v pgdata:/var/lib/postgresql/data`처럼 이름 있는 볼륨을 쓰면 Docker가 볼륨 디렉토리 소유권을 remap에 맞게 알아서 관리해줘서 이 문제가 아예 없습니다(직접 확인함). `/code` 아래 실제 파일로 남기고 싶은 게 아니라면 이쪽이 더 간단합니다.
   - bind mount를 꼭 써야 한다면, 처음 한 번 dind 컨테이너 자신의 root로(`code-docker`가 아니라 `code-docker-dind`) 대상 디렉토리 소유권을 remap 대역으로 바꿔주세요: `docker exec code-docker-dind chown -R 165536:165536 /code/myproject/pgdata` — 이 명령 자체는 `code-docker`가 아니라 `code-docker-dind`(dind 자신)에서 실행해야 합니다(dind는 여전히 진짜 root라 임의 UID로 chown 가능하지만, code-docker에서 호스트 UID로 직접 chown하려면 보통 sudo/root 권한이 추가로 필요합니다).
3. `dind-authz`만으로 이미 privileged/위험한 CapAdd/host 네임스페이스/`/code` 밖 마운트가 다 막혀 있어서, remap이 추가로 막는 건 "지금 알려진 구멍"이 아니라 "authz 플러그인 자체가 뚫렸을 때/아직 모르는 컨테이너 런타임 버그가 터졌을 때"에 대한 보험 성격입니다 — 필수는 아니지만, 위 제약을 감수할 수 있고 LXC 같은 중첩 호스트가 아니라면 켜서 손해 볼 건 없습니다.

설계 배경 전체(왜 이 방식을 택했는지, 다른 대안들을 왜 버렸는지)는 `code-dind/.claude/dind-authz-plan.md`를 참고하세요.

webmanager의 [Docker/dind 관리 탭](../webmanager.md#dockerdind-관리)에서 컨테이너/이미지 목록, 로그 조회, 시작/정지/삭제도 브라우저에서 바로 할 수 있습니다.
