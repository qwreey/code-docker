# roblox-studio-docker 연동

[`roblox-studio-docker`](https://github.com/qwreey/roblox-studio-docker)(Wine 기반 Roblox
Studio 컨테이너, GPU passthrough + headless Wayland + wayvnc)는 code-docker와는 완전히
독립된 별도 프로젝트입니다 - code-docker에 submodule 등으로 포함되어있지 않고, code-docker
쪽 `docker-compose.yml`이 제공하는 범용 오버레이 훅(`EXTRA_INCLUDE`)을 통해 옆에서
붙습니다. 이 문서는 code-docker 쪽에서 알아야 할 연동 방법만 다룹니다 - roblox-studio-docker
자신의 설정은 그 repo의 문서를 참고하세요.

## ootb.sh로 자동 연동하기 (권장)

roblox-studio-docker는 [`ootb-manifest.env`](ootb-manifest.md)를 들고 있으므로,
[`ootb.sh`](../index.md#ootbsh로-한-번에-설치하기) 실행 중 "추가 프로젝트 git URL"
프롬프트에 `https://github.com/qwreey/roblox-studio-docker.git`을 입력하면 clone,
`extra-include.yml` 작성, `EXTRA_INCLUDE=extra-include.yml` 설정까지 전부 자동으로
됩니다 - `roblox-studio-vnc` 네트워크의 DOCKER-USER 예외는 이제 roblox-studio-docker
자신의 오버레이 파일(`roblox-studio-code-docker.yml`)이 그 네트워크에
`netinit.exempt-forward: "true"` 라벨을 직접 달아서 선언하므로, code-docker 쪽 `.env`를
따로 건드릴 필요가 없습니다(아래 "VNC 전용 네트워크 격리" 참고). router가 VNC를 프록시
대상으로 삼을 수 있게 하는 allowlist 등록(`.env.router`의
`ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`에 `vnc-only` 추가)도 매니페스트의
`OOTB_ROUTER_ALLOWED_TARGET_HOSTS` 필드를 통해 자동으로 됩니다 - 아래 "수동으로
연동하기"는 `ootb.sh`를 안 쓰거나 이미 설치된 인스턴스에 나중에 붙일 때만 필요합니다.

## 수동으로 연동하기

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

마지막으로, router의 VNC 탭/App Routes/Dev Proxy가 Studio를 대상으로 삼을 수 있도록
`.env.router`에 대상 호스트를 허용해줘야 합니다 - 기본 allowlist는 `code-docker`/`dind`
둘뿐이라([대상 호스트 allowlist](../../router/docs/vnc.md#대상-호스트-allowlist) 참고),
이걸 빼먹으면 스택은 멀쩡히 뜨는데 대상 등록만 `target host ... is not in the allowed
target host list`로 거부됩니다:

```sh
ROUTER_EXTRA_ALLOWED_TARGET_HOSTS=vnc-only
```

(`ootb.sh`로 연동했다면 매니페스트가 이 값을 선언하고 있어 자동으로 병합되고,
이미 연동된 배포도 `migrate.sh`가 사이드 프로젝트를 pull하면서 다시 반영해줍니다.)

## VNC 전용 네트워크 격리

roblox-studio-docker는 Studio의 VNC 포트(5900)를 host에 직접 게시하지 않고, `router`만
접근 가능한 별도 `internal: true` 네트워크(`roblox-studio-vnc`)에 올리는 방식을 씁니다 -
code-docker/dind(임의 웹브라우징 + npm/pip 설치 + MCP 툴콜을 하는, 상대적으로 신뢰 수준이
낮은 에이전트 컨테이너)는 이 네트워크에 아예 붙지 못하고, code-docker가 자기 네트워크
바깥으로 나갈 때 반드시 router를 거치는 것과 같은 "국경은 router만" 원칙을 VNC 접근에도
그대로 적용한 것입니다.

이 네트워크가 `code-docker-internal`이 아닌 별도 네트워크이기 때문에, 최신 Docker Engine의
`DOCKER-USER`/`DOCKER-INTERNAL` 하드닝이 router의 forward 트래픽을 막습니다 - 그 예외
규칙은 이제 roblox-studio-docker 자신의 `roblox-studio-code-docker.yml`이
`roblox-studio-vnc` 네트워크에 직접 라벨을 달아서 선언합니다:

```yaml
networks:
  roblox-studio-vnc:
    labels:
      netinit.provider: "${PREFIX:-}code-docker-netinit-docker"
      netinit.exempt-forward: "true"
```

`code-docker-netinit-docker`(구 `code-docker-netfilter-fix` - DOCKER-USER 예외 동기화에
더해 컨테이너의 기본 라우트를 호스트에서 심어주는 일도 겸하게 되면서 개명됨)가 이 라벨을
보고 `roblox-studio-vnc`에도 `code-docker-internal`과 같은 DOCKER-USER 예외를 걸어줍니다 -
code-docker 쪽 `.env`를 전혀 건드릴 필요가 없습니다. (예전에는 `.env`의
`NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS`에 네트워크 이름을 나열해야 했습니다 - 그 값은
아직 라벨로 옮기지 않은 배포를 위한 호환 경로로 한동안 남아있지만 **DEPRECATED**이고,
`code-docker-netinit-docker`가 그 값을 읽으면 경고를 로그로 남깁니다. 설계 배경은
`.claude/archive/netinit-docker-plan-done.md` 참고.)

`roblox-studio-vnc` 네트워크 자신의 이름도 `roblox-studio-docker`의 `roblox-studio-code-docker.yml`
쪽에서 `${PREFIX:-}roblox-studio-vnc`로 정의돼 있습니다(컨테이너 이름 `roblox-studio`도
마찬가지) - `PREFIX`가 다른 code-docker 인스턴스 두 개가 각자 roblox-studio-docker를
연동해도 컨테이너/네트워크 이름이 안 겹치게 하기 위해서입니다. 위 `netinit.provider` 라벨
값(`${PREFIX:-}code-docker-netinit-docker`)도 같은 오버레이 파일 안에서 같은 `PREFIX`를
참조하므로 자동으로 일치합니다 - 예전처럼 code-docker 쪽 값과 사이드 프로젝트 쪽 값을 손으로
맞출 필요가 없습니다.

`studio-netinit` 사이드카는 더 이상 없습니다. 예전에는 `network_mode: service:studio`로
붙어 `studio`의 네트워크 네임스페이스를 공유했는데, 컴포즈가 그 연결을 대상의 **컨테이너
ID에 고정**해서 저장하는 바람에 `studio`를 재생성(재빌드, 혹은 붙은 네트워크 변경 등)할
때마다 사이드카가 영구히 고아가 되는 문제가 있었습니다(`studio`는 `Up`인데 라우트만 없는
채로, `docker ps`엔 안 보임) - 자세한 경위는 `.claude/archive/netinit-docker-plan-done.md`
참고. 지금은 `studio`가 `netinit.provider` 라벨 하나만으로 `code-docker-netinit-docker`에
옵트인하고, 라우트는 호스트 쪽 에이전트가 컨테이너 밖에서 심어줍니다(`studio`는
`NET_ADMIN`을 여전히 갖지 않습니다) - `studio` 하나만 단독으로 재생성해도 이제 안전합니다.
대신 `studio`의 `entrypoint.sh`는 `NETINIT_WAIT=true`가 설정된 경우(코드-docker와 함께 뜨는
`roblox-studio-code-docker.yml` 오버레이가 켭니다 - 단독 실행 시 기본값은 `false`) 자기
기본 라우트가 생길 때까지 대기한 뒤에야 실제 워크로드를 시작합니다 - 호스트 에이전트는
컨테이너가 뜬 *뒤에만* 라우트를 심을 수 있기 때문이고, 이 대기는 fail-closed입니다(타임아웃
시 `NETINIT_WAIT_TIMEOUT`, 기본 60초 - 그냥 진행하지 않고 종료해서 `restart:
unless-stopped`가 재시도하게 합니다).

```sh
EXTRA_INCLUDE=extra-include.yml docker compose up -d
```

## router forwards로 VNC 접속하기

VNC는 host에 직접 노출되지 않으므로, [router 문서의 forwards 설정](../../router/docs/router.md#forwards--publish)으로
Studio의 5900 포트를 원하는 host 포트에 매핑해야 실제로 접속할 수 있습니다 -
target host는 **`studio`가 아니라 `vnc-only`**, target port는 `5900`입니다. 이 forward는
compose에 박혀있지 않고 router-manager UI/API로 실행 중에 추가/삭제하는 값입니다.

> **`studio`를 쓰면 안 되는 이유**: `studio` 컨테이너는 `code-docker-internal`과
> `roblox-studio-vnc` 두 망에 모두 붙어있고 router도 그 둘에 다 붙어있으므로, router가
> `studio`를 resolve하면 A 레코드가 **두 개** 돌아옵니다(어느 쪽이 먼저 올지는 보장되지
> 않음). netgate의 forwards는 그 중 첫 번째 IP를 골라 DNAT 규칙으로 굳혀버리는데
> (`config/netgate/firewall.default.sh`의 `getent hosts`), wayvnc는 `VNC_BIND_ALIAS`가
> resolve된 IP - 즉 `roblox-studio-vnc` 쪽 IP - 에만 바인딩합니다. `code-docker-internal`
> 쪽 IP가 뽑히면 그 포트엔 아무도 듣고 있지 않아 `connection refused`가 되고, 재적용될
> 때마다 결과가 달라질 수 있습니다. `vnc-only`는 `roblox-studio-vnc` 위에만 존재하는
> 별칭이라 항상 정확히 하나의 IP로 풀립니다(그게 이 별칭을 따로 둔 이유 전부입니다 -
> `roblox-studio-code-docker.yml`의 `VNC_BIND_ALIAS` 주석 참고). router의 VNC 탭도 같은
> 이유로 대상 호스트를 항상 `vnc-only`로 잡습니다 - 권장 구성은 `rfb` 백엔드로
> `vnc-only:5900`을 대상으로 등록하는 것입니다(wayvnc가 이미 그 별칭의 `5900`번에
> 바인딩하고 있으므로 roblox-studio-docker 쪽 변경은 필요 없습니다). 대상 자신의 웹
> VNC 프런트엔드를 거치는 `novnc` 백엔드(App Routes를 통한 경로, `vnc-only:6080`)도
> 여전히 쓸 수 있습니다.

## 확인 & 흔한 문제

- `docker compose config`로 오버레이가 실제로 병합됐는지(서비스 목록에 `studio` 등이
  보이는지) 먼저 확인하세요.
- `studio` 컨테이너 안에서 `ip route show default`가 router를 가리키는 게 아니라면
  `code-docker-netinit-docker`가 `studio`를 못 찾은 것입니다 - `studio`에
  `netinit.provider` 라벨이 붙어있는지, 그 값(`${PREFIX:-}code-docker-netinit-docker`)이
  실제 `PREFIX`까지 포함해서 `code-docker-netinit-docker` 컨테이너 이름과 정확히
  일치하는지 확인하세요. `NETINIT_WAIT=true`가 켜져 있다면 라우트가 없는 동안 `studio`
  자체가 재시작을 반복합니다(fail-closed) - `docker compose logs studio`에서 대기
  타임아웃 로그를 확인할 수 있습니다.
- Studio가 `Temporary failure in name resolution`(또는 `clientsettings.roblox.com` 조회
  실패)로 시작 자체를 못 하면 DNS 문제입니다. `internal: true` 네트워크 위의 컨테이너는
  Docker 내장 DNS(`127.0.0.11`)가 자기가 모르는 이름에 즉시 **확정** SERVFAIL을
  돌려주기 때문에, 외부 이름을 하나도 못 찾습니다. 그래서 `studio`는 `dns-local`
  프로그램(strict-order dnsmasq)을 함께 띄우고, code-docker 쪽 오버레이가
  `DNS_LOCAL_ENABLED=true`를 켜줍니다(단독 실행 시에는 기본 `false`).
  `docker compose exec studio cat /etc/resolv.conf`가 `nameserver 127.0.0.1`이 아니라면
  이 프로그램이 안 떴거나 꺼져 있는 것입니다 — `supervisorctl status dns-local`과
  그 로그를 확인하세요. 이건 2026-08-27에 추가됐으므로, 그 이전에 빌드한 이미지를
  쓰고 있다면 `docker compose build --no-cache studio`가 필요합니다(`dns-local`은
  floating `#main` 원격 git 컨텍스트로 받아오는데 Docker가 그 fetch를 캐시합니다).
- router의 VNC 탭/App Routes에서 대상을 추가할 때 `target host ... is not in the allowed
  target host list`가 뜨면 `.env.router`의 `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`에
  `vnc-only`가 들어있는지 확인하세요(위 "수동으로 연동하기" 참고) - 컨테이너 자체는
  정상적으로 뜨기 때문에 다른 증상은 안 보입니다. 이 값은 `.env`가 아니라 `.env.router`에
  있어야 하고, 고친 뒤 router 컨테이너를 재시작해야 반영됩니다.
- forward를 추가했는데도 접속이 안 되면, `code-docker-netinit-docker` 로그에서
  `roblox-studio-vnc`에 대한 DOCKER-USER 예외 규칙이 실제로 걸렸는지 확인하세요 - 그
  네트워크에 `netinit.exempt-forward: "true"` 라벨이 붙어있는지가 가장 흔한 원인입니다
  (아직 예전 방식인 `NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS`로 설정하고 있다면 그 값의
  오타/누락도 확인하세요).
