# roblox-studio-docker 연동

[`roblox-studio-docker`](https://github.com/qwreey/roblox-studio-docker)(Wine 기반 Roblox
Studio 컨테이너, GPU passthrough + headless Wayland + wayvnc)는 code-docker와는 완전히
독립된 별도 프로젝트입니다 - code-docker에 submodule 등으로 포함되어있지 않고, code-docker
쪽 `docker-compose.yml`이 제공하는 범용 오버레이 훅(`EXTRA_INCLUDE`)을 통해 옆에서
붙습니다. 이 문서는 code-docker 쪽에서 알아야 할 연동 방법만 다룹니다 - roblox-studio-docker
자신의 설정은 그 repo의 문서를 참고하세요.

## EXTRA_INCLUDE로 연결하기

`docker-compose.yml` 최상단에 `include: - path: ${EXTRA_INCLUDE:-empty-extra-include.yml}`
가 있습니다 - 기본값은 아무 것도 안 하는 빈 파일이라, 아무 설정도 안 하면 code-docker는
평소와 똑같이 동작합니다. 다른 프로젝트를 붙이고 싶다면:

```sh
git clone https://github.com/qwreey/roblox-studio-docker.git builds/roblox-studio-docker
```

`docker-compose.yml`이 있는 위치(예: `~/code-docker/`)에 `extra-include.yml`을 직접
만듭니다 (버전관리 대상 아님, `.gitignore`에 이미 등록되어있음):

```yaml
# extra-include.yml
include:
  - path: builds/roblox-studio-docker/roblox-studio-code-docker.yml
```

그리고 `.env`에 `EXTRA_INCLUDE=extra-include.yml`을 설정하면, `docker compose up` 할 때
roblox-studio-docker가 정의한 서비스(`studio` 등)가 같이 뜨고 code-docker의 네트워크에
붙습니다. `code-docker-router`처럼 이 프로젝트가 이미 정의한 서비스에도 필드를 병합해
추가할 수 있으므로 (`networks:` 목록에 항목만 더 추가하는 식), roblox-studio-docker 쪽
오버레이 파일이 router를 자기 네트워크에 끌어들이는 것도 가능합니다 - 아래 VNC 격리가
바로 이 방식을 씁니다.

> `extra-include.yml`은 `docker-compose.yml`과 물리적으로 같은 위치를 기준으로
> `include: path:`를 해석합니다 (git 레포 기준이 아님) - `builds/code-docker`에 클론해서
> `docker-compose.yml`만 한 단계 위로 복사해 쓰는 배포 구조([기본 사용법](../index.md)
> 참고)라면, roblox-studio-docker도 같은 위치 기준 `builds/roblox-studio-docker/`에
> 클론해야 경로가 맞습니다.

## VNC 전용 네트워크 격리

roblox-studio-docker는 Studio의 VNC 포트(5900)를 host에 직접 게시하지 않고, `router`만
접근 가능한 별도 `internal: true` 네트워크(`roblox-studio-vnc`)에 올리는 방식을 씁니다 -
code-docker/dind(임의 웹브라우징 + npm/pip 설치 + MCP 툴콜을 하는, 상대적으로 신뢰 수준이
낮은 에이전트 컨테이너)는 이 네트워크에 아예 붙지 못하고, code-docker가 자기 네트워크
바깥으로 나갈 때 반드시 router를 거치는 것과 같은 "국경은 router만" 원칙을 VNC 접근에도
그대로 적용한 것입니다.

이 네트워크가 `code-docker-internal`이 아닌 별도 네트워크이기 때문에, 최신 Docker Engine의
`DOCKER-USER`/`DOCKER-INTERNAL` 하드닝이 router의 forward 트래픽을 막습니다 -
`.env`에서 `CODE_DOCKER_EXTRA_INTERNAL_NETWORKS=roblox-studio-vnc`를 설정하면
`code-docker-netfilter-fix`가 그 네트워크에도 같은 예외 규칙을 걸어줍니다
(공백으로 구분해 여러 네트워크를 나열할 수 있습니다). `CODE_DOCKER_INTERNAL_NETWORK`
(code-docker 자신의 네트워크)과는 별개 변수이므로, 사이드 프로젝트 쪽 오버레이가 이 값을
설정해도 code-docker 자신의 기본 예외 규칙을 덮어쓸 일은 없습니다.

두 서비스(`studio`, `studio-netinit`)는 항상 함께 재생성해야 합니다 - `studio`는
`network_mode: service:studio-netinit`으로 붙어 네트워크 네임스페이스를 공유하므로,
`studio`만 따로 재생성하면 라우팅이 깨집니다. 합쳐서 다시 띄우려면:

```sh
EXTRA_INCLUDE=extra-include.yml CODE_DOCKER_EXTRA_INTERNAL_NETWORKS=roblox-studio-vnc \
  docker compose up -d
```

## router forwards로 VNC 접속하기

VNC는 host에 직접 노출되지 않으므로, [router 문서의 forwards 설정](../../router/docs/router.md#forwards--publish)으로
`studio`의 5900 포트를 원하는 host 포트에 매핑해야 실제로 접속할 수 있습니다 -
target host는 `studio`(roblox-studio-vnc 네트워크 위에서 router가 알아서 resolve),
target port는 `5900`. 이 forward는 compose에 박혀있지 않고 router-manager UI/API로 실행
중에 추가/삭제하는 값입니다.

## 확인 & 흔한 문제

- `docker compose config`로 오버레이가 실제로 병합됐는지(서비스 목록에 `studio` 등이
  보이는지) 먼저 확인하세요.
- `studio` 컨테이너 안에서 `ip route show default`가 router를 가리키는 게 아니라면
  `studio-netinit` 사이드카가 제대로 안 뜬 것입니다 - 두 서비스를 같이 재생성했는지
  확인하세요.
- forward를 추가했는데도 접속이 안 되면, `code-docker-netfilter-fix` 로그에서
  `roblox-studio-vnc`에 대한 예외 규칙이 실제로 걸렸는지 확인하세요
  (`CODE_DOCKER_EXTRA_INTERNAL_NETWORKS` 오타/누락이 가장 흔한 원인입니다).
