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

> 보안 주의: `code-docker-dind` 는 `privileged: true` 로 구동되며, 인증/TLS 없는 평문 tcp 소켓(2375)이 열려있습니다. `code-docker-external` 로부터는 격리되어있지만, `code-docker-internal` 네트워크에 연결된 컨테이너라면 누구든 이 소켓에 요청을 보낼 수 있습니다. 아래 "요청 단위 제한 (dind-authz)" 절 덕분에 기본값에서는 이 소켓을 통해 생성되는 컨테이너 자체가 특권을 요구할 수 없게 막혀있지만, 그래도 `code-docker-internal` 에는 신뢰할 수 있는 서비스만 연결하고 code-docker 접근 권한을 신뢰할 수 없는 사용자에게 주지 않는 것이 기본 전제입니다.

## 요청 단위 제한 (dind-authz)

`docker-compose.yml`의 `DIND_TARGET` 이 어떤 Dockerfile 스테이지를 dind로 쓸지 고릅니다 (`example-env` 참고):

- `dind` — 보호 없음, 예전 기본 동작 그대로.
- `dind-authz` (**기본값**) — dind 안의 dockerd에 authorization 플러그인(`dind-authz/`, 순수 Go 표준 라이브러리로 작성)이 붙어서, 컨테이너 생성 요청에 아래 중 하나라도 포함되면 요청 자체를 거부합니다:
  - `--privileged`
  - `allowed_caps` 허용 목록(기본은 `NET_BIND_SERVICE`만) 밖의 `--cap-add`
  - `--security-opt seccomp=unconfined`/`apparmor=unconfined`/`label=disable`
  - `--pid=host`, `--network=host`, `--ipc=host`, `--cgroupns=host`
  - `--device`, `--device-cgroup-rule`
  - `/code/` 아래가 아닌 경로를 소스로 하는 bind mount (named volume은 영향 없음)
- `dind-authz-remap` — 아직 구현되지 않음. LXC 등 중첩 가상화 호스트에서 userns-remap이 호환성 문제를 일으킬 수 있어 별도 스테이지로 분리해둔 계획입니다.

정책은 이미지에 구운 기본값(`config/dind-authz/*.default.json`)과, `DIND_AUTHZ_VOLUME`(기본 `./dind-authz`)로 마운트되는 실시간 conf.d 디렉토리를 병합한 결과입니다. **이 디렉토리는 code-docker 어디에도 마운트되지 않습니다** — code-docker 자신이 자기를 제한하는 정책을 고칠 수 있으면 의미가 없기 때문에, 도커 호스트 자체에 파일시스템 접근 권한이 있는 사람만 편집할 수 있습니다. 예를 들어 특정 capability를 추가로 허용하려면:

```json
// ./dind-authz/10-my-exception.json (도커 호스트에서 직접 작성)
{ "allowed_caps": { "SYS_PTRACE": true } }
```

파일을 추가/수정한 뒤 `docker compose restart code-docker-dind` 하면 반영됩니다 (재빌드는 필요 없습니다).

`/code/` 아래로만 bind mount를 허용하는 이유는 보안뿐 아니라 실용적인 이유도 있습니다 — dind는 bind mount의 source 경로를 **자기 자신의 파일시스템 기준**으로 해석하므로(code-docker가 아니라), `code-docker-dind`에도 `/code`가 code-docker와 동일한 호스트 경로로 마운트되어 있습니다. 그래서 프로젝트 자신의 `docker-compose.yml`에 있는 `./data:/var/lib/postgresql/data` 같은 흔한 상대경로 마운트도 (프로젝트가 `/code` 아래에 있는 한) 정상적으로 동작합니다.

설계 배경과 구현되지 않은 부분(userns-remap 등)은 `.claude/backlog/dind-authz-plan.md`를 참고하세요.

webmanager의 [Docker/dind 관리 탭](../webmanager.md#dockerdind-관리)에서 컨테이너/이미지 목록, 로그 조회, 시작/정지/삭제도 브라우저에서 바로 할 수 있습니다.
