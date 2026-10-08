# roblox-studio-docker 연동

[`roblox-studio-docker`](https://github.com/qwreey/roblox-studio-docker)는 Wine 위에서 Roblox Studio를 돌리는 컨테이너입니다 (GPU passthrough + headless Wayland + wayvnc). code-docker와는 완전히 독립된 별도 프로젝트로, submodule이 아니라 `EXTRA_INCLUDE` 오버레이 훅으로 옆에 붙습니다. 붙이고 나면 **브라우저로 Studio 화면을 보고**, **code-docker 안의 Claude Code가 Studio를 직접 조작**할 수 있습니다.

이 문서는 code-docker 쪽에서 알아야 할 것만 다룹니다 - Studio 자신의 설정(Roblox 로그인, VNC 클라이언트 선택 등)은 그 repo의 문서를 참고하세요.

## 붙이기

[`ootb.sh`](../index.md#ootbsh로-한-번에-설치하기)를 실행하다 "추가 프로젝트 git URL" 프롬프트가 나오면 아래를 입력하면 끝입니다. 이미 설치된 배포라면 [`migrate.sh`](../index.md#업데이트하기)의 "새 사이드 프로젝트를 추가할까요?" 단계에서 같은 값을 넣으면 됩니다.

```
https://github.com/qwreey/roblox-studio-docker.git
```

clone, `extra-include.yml` 작성, `EXTRA_INCLUDE` 설정, router 대상 allowlist 등록, MCP 토큰 생성까지 전부 자동입니다. 그 다음 `docker compose up -d` 하면 `studio` 서비스가 같이 뜹니다.

<details>
<summary>ootb가 대신 해주는 설정이 정확히 무엇인지</summary>

roblox-studio-docker가 들고 다니는 [`ootb-manifest.env`](ootb-manifest.md)에 선언된 것들입니다:

- **`extra-include.yml`에 오버레이 등록** - `builds/roblox-studio-docker/roblox-studio-code-docker.yml`
- **`.env`의 `EXTRA_INCLUDE=extra-include.yml`**
- **`.env.router`의 `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`에 `roblox-studio-vnc` 추가** - router의 VNC 탭/App Routes/Dev Proxy가 대상으로 삼을 수 있는 호스트 allowlist는 기본이 `code-docker`/`dind` 둘뿐입니다([대상 호스트 allowlist](https://github.com/qwreey/router-docker/blob/HEAD/docs/vnc.md#대상-호스트-allowlist)). 이걸 빼먹으면 스택은 멀쩡히 뜨는데 대상 등록만 `target host ... is not in the allowed target host list`로 거부됩니다.
- **`.env`의 `MCP_TOKEN` 생성** - 묻지 않고 만들어 넣고 값을 화면에 출력합니다. 아래 [Studio MCP](#claude-code에-studio-mcp-붙이기) 참고.

DOCKER-USER 방화벽 예외는 `.env`에 쓰이지 않습니다 - roblox-studio-docker 쪽 오버레이가 자기 네트워크에 라벨로 직접 선언합니다(아래 [격리 구조](#격리-구조) 참고).

이미 연동해둔 배포는 `migrate.sh`가 사이드 프로젝트를 git pull하면서 위 항목들을 다시 반영해줍니다 - 매니페스트에 새 항목이 생겨도 따라옵니다.

</details>

<details>
<summary>ootb 없이 수동으로 붙이기</summary>

code-docker의 `docker-compose.yml` 최상단에는 `include: - path: ${EXTRA_INCLUDE:-empty-extra-include.yml}`가 있습니다. 기본값은 아무 것도 안 하는 빈 파일이라, 설정하지 않으면 code-docker는 평소와 똑같이 동작합니다.

```sh
git clone https://github.com/qwreey/roblox-studio-docker.git builds/roblox-studio-docker
```

`docker-compose.yml`이 있는 위치(예: `~/code-docker/`)에 `extra-include.yml`을 만듭니다 (버전관리 대상 아님, `.gitignore`에 이미 있음):

```yaml
# extra-include.yml
include:
  - path: builds/roblox-studio-docker/roblox-studio-code-docker.yml
```

`.env`에 `EXTRA_INCLUDE=extra-include.yml`, `.env.router`에 `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS=roblox-studio-vnc`를 설정하면 `docker compose up`에 `studio`가 따라옵니다.

> `extra-include.yml`의 `include: path:`는 git 레포가 아니라 **`docker-compose.yml`이 물리적으로 있는 위치** 기준입니다 - `builds/code-docker`에 클론하고 `docker-compose.yml`만 한 단계 위로 복사해 쓰는 배포 구조([기본 사용법](../index.md))라면, roblox-studio-docker도 같은 기준으로 `builds/roblox-studio-docker/`에 있어야 경로가 맞습니다.

오버레이는 `code-docker-router`처럼 **code-docker가 이미 정의한 서비스에도 필드를 병합**할 수 있습니다(`networks:` 목록에 항목 추가 등). VNC 격리가 바로 이 방식으로 router를 자기 네트워크에 끌어들입니다.

</details>

## VNC로 Studio 화면 보기

VNC 포트는 host에 게시되지 않습니다. 접속 경로는 두 가지고, 둘 다 대상 호스트는 **`studio`가 아니라 `roblox-studio-vnc`** 입니다.

- **router의 VNC 탭** (권장) - `rfb` 백엔드로 `roblox-studio-vnc:5900`을 등록하면 브라우저에서 바로 봅니다. 대상 자신의 웹 VNC 프런트엔드를 거치는 `novnc` 백엔드(`roblox-studio-vnc:6080`, App Routes 경유)도 여전히 쓸 수 있습니다.
- **네이티브 VNC 클라이언트** - router의 [forwards](https://github.com/qwreey/router-docker/blob/HEAD/docs/router.md#forwards--publish)로 `roblox-studio-vnc:5900`을 원하는 host 포트에 매핑합니다. compose에 박는 값이 아니라 router-manager UI/API로 실행 중에 추가/삭제합니다.

<details>
<summary>왜 <code>studio</code>가 아니라 <code>roblox-studio-vnc</code>인지</summary>

`studio` 컨테이너는 `roblox-studio-net`과 `roblox-studio-vnc` **두 망에 모두** 붙어있고 router도 그 둘에 다 붙어있습니다. 그래서 router가 `studio`를 resolve하면 A 레코드가 두 개 돌아오고, 어느 쪽이 먼저 올지는 보장되지 않습니다.

netgate의 forwards는 그중 첫 번째 IP를 골라 DNAT 규칙으로 굳혀버리는데(`config/netgate/firewall.default.sh`의 `getent hosts`), wayvnc는 `VNC_BIND_ALIAS`가 resolve된 IP - 즉 `roblox-studio-vnc` 쪽 IP - 에만 바인딩합니다. `roblox-studio-net` 쪽 IP가 뽑히면 그 포트엔 아무도 듣고 있지 않아 `connection refused`가 되고, 규칙이 재적용될 때마다 결과가 달라질 수 있습니다.

별칭 `roblox-studio-vnc`는 같은 이름의 `roblox-studio-vnc` **망 위에만** 존재해서 항상 정확히 하나의 IP로 풀립니다 - 이 별칭을 따로 둔 이유가 그것뿐입니다(망과 같은 이름인 건 [code-docker-chrome](https://github.com/qwreey/code-docker-chrome)의 `chrome-vnc`와 맞춘 것입니다. 예전 이름은 `vnc-only`였습니다). router의 VNC 탭이 대상 호스트를 항상 `roblox-studio-vnc`로 잡는 것도 같은 이유입니다.

</details>

## Claude Code에 Studio MCP 붙이기

Roblox Studio는 MCP 서버를 내장하고 있지만 **stdio 전용 + 같은 머신 전용**이라 원격 클라이언트가 붙을 포트가 없습니다. roblox-studio-docker가 이걸 밖으로 꺼내주기 때문에, code-docker 안의 Claude Code가 `studio:8787`로 붙을 수 있습니다. 이 이름은 Studio 본체가 아니라 두 망 사이의 중계 컨테이너 `roblox-studio-front`입니다(아래 [격리 구조](#격리-구조) 참고).

```
claude (code-docker) → studio:8787/mcp → roblox-studio-front → caddy → supergateway → StudioMCP.exe(wine)
                       └─ code-docker-internal ─┘└─ roblox-studio-net ─┘            ↓ WebSocket
                                                                       Studio의 Assistant 플러그인
```

**1. 토큰** — `MCP_TOKEN`은 ootb/migrate가 알아서 `.env`에 넣습니다. 아무것도 안 해도 됩니다.

**2. Studio 안에서 한 번 켜기 (VNC 필요, CLI 대체 수단 없음)** — Studio가 로그인된 상태에서 **Assistant 패널 → … → Manage MCP Servers → "Enable Studio as MCP server"**. 이때 Studio가 `StudioMCP.exe`를 만들고, 브리지는 그 파일을 실행합니다.

**3. 등록** — code-docker 컨테이너 안의 셸(code-server 터미널, webmanager 터미널, ssh 아무거나)에서:

```sh
claude mcp add --transport http roblox-studio \
  http://studio:8787/mcp \
  --header "Authorization: Bearer $MCP_TOKEN" \
  -s user
claude mcp list   # roblox-studio: ... (HTTP) - ✔ Connected
```

`$MCP_TOKEN`은 컨테이너 안에서 그대로 풀리므로 값을 찾아 넣을 필요 없습니다. `-s user`를 권합니다(컨테이너가 곧 1인 사용자 환경). **`-s project`는 쓰지 마세요** - 토큰이 박힌 `.mcp.json`이 레포에 커밋됩니다.

<details>
<summary>토큰 값 확인, 끄기, 손으로 설정하기</summary>

ootb는 **생성한 순간에만** 값을 출력합니다. 나중에 다시 보려면:

```sh
grep MCP_TOKEN .env                                   # 호스트에서
docker compose exec code-docker printenv MCP_TOKEN    # 붙는 쪽 컨테이너에서
```

두 번째가 값을 뱉는 건 `roblox-studio-code-docker.yml`이 `code-docker` 서비스에도 `MCP_TOKEN`을 병합해주기 때문입니다 - code-docker 자신의 compose에는 이 변수가 없습니다(이 사이드 프로젝트를 모르니 당연하고, 값을 넘기는 건 오버레이의 일입니다).

**끄려면** `.env`의 `MCP_TOKEN` 줄을 빈 값으로 두세요. 브리지가 idle로 뜨고, `ootb`/`migrate`는 이미 있는 키를 덮어쓰지 않으므로 그 상태가 유지됩니다(그때마다 "빈 값이라 꺼진 것으로 봅니다" 한 줄을 남깁니다 - 껐다는 걸 잊고 고장으로 오해하지 않도록).

**반대로 꺼져 있는 걸 다시 켜려면** 값을 직접 채우거나, `MCP_TOKEN=` 줄을 통째로 지우고 `migrate.sh`를 돌리면 새로 생성됩니다.

**손으로 넣으려면** code-docker 쪽 `.env`에 씁니다 - `include`로 들어온 사이드 프로젝트의 compose 파일도 최상위 프로젝트의 `.env`를 먼저 보고, 사이드 프로젝트 자신의 `.env`는 폴백으로만 쓰입니다(Compose 5.5 기준 실측):

```sh
printf '\nMCP_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
docker compose up -d studio code-docker   # restart 아님 - env는 create 시점에 박힙니다
```

`migrate.sh`가 값을 만들어줘도 마찬가지로 **`studio`와 `code-docker` 둘 다 재생성**돼야 반영됩니다(브리지를 켜는 쪽과 그 토큰으로 붙는 쪽). migrate 마지막의 `docker compose up -d`가 resolved config 변경을 보고 양쪽을 재생성해주지만, 그 단계를 건너뛰었다면 위 명령을 직접 실행하세요.

</details>

<details>
<summary>이 토큰이 실제로 막는 것 (그리고 왜 묻지 않는지)</summary>

`code-docker-internal` 위에서만(`roblox-studio-front`를 거쳐) 닿는 포트에 굳이 토큰이 필요한지는 따져볼 만합니다. 통합 배포에서 이 토큰은 인증 경계라기보다 **심층방어 한 겹**입니다:

- **code-docker 자신에게는 사실상 무의미합니다.** 토큰이 `.env`와 `~/.claude.json`에 있으므로, code-docker 안에서 뭔가 잘못되면(공급망 공격 등) 토큰도 같이 털립니다.
- **의미가 있는 건 dind 안에서 사용자가 직접 띄운 컨테이너입니다.** 그것들은 이름으로 `studio`를 찾지는 못하지만(중첩 daemon은 별도 네트워크/DNS - [dind.md](dind.md) 참고) 내부 daemon의 NAT를 통해 `code-docker-internal` 대역에 IP로는 닿을 수 있는 구조이고, 토큰은 볼 수 없습니다. 신뢰하지 않는 이미지를 `docker run` 하는 게 이 환경의 일상적인 용법이라는 걸 생각하면 이쪽은 실질적인 방어입니다. (구조상 그렇다는 것이고 이 경로를 따로 실측하지는 않았습니다.)
- **단독 실행(roblox-studio-docker의 `docker-compose.yml`만 쓰는 경우)에서는 진짜 인증 경계입니다** - 그때는 MCP 포트가 host에 실제로 게시됩니다.

**그래서 사용자에게 묻지 않습니다.** 예전에는 ootb가 "MCP 브리지를 활성화할까요?"를 y/N로 묻고 기본값을 "아니오"로 뒀는데, 그 질문에는 답할 내용이 없습니다 - 브리지를 켜두는 것 자체로는 아무 권한도 생기지 않기 때문입니다. **진짜 capability 게이트는 위 2번, Studio 안 Assistant의 토글**입니다. 사람이 VNC로 직접 켜야 하고 CLI 대체 수단이 없으며, 그게 꺼져 있으면 브리지는 실행할 `StudioMCP.exe` 자체가 없습니다. 그 앞에 y/N을 하나 더 세우는 건 보안을 늘리지 않고 "깔면 그냥 된다"만 깨뜨립니다.

</details>

<details>
<summary>주소가 왜 host 포트가 아니라 <code>studio:8787</code>인지</summary>

통합 배포에서 `MCP_PORT`는 host에 게시되지 않습니다. `studio`가 `internal: true` 네트워크에만 붙어있으면 Docker는 그 컨테이너의 host publish DNAT를 **조용히 건너뜁니다** - 예전 오버레이가 `MCP_PORT`만 남겨뒀을 때 실제로 아무것도 게시되지 않고 있었습니다(에러도 없이).

VNC와 달리 `roblox-studio-vnc` 별칭을 쓰지 않는 이유는, MCP를 쓰는 주체가 사람이 아니라 `code-docker-internal` 위의 에이전트 컨테이너 자신이기 때문입니다 - router를 거칠 이유가 없는 통신입니다. 반대로 code-docker **바깥**(예: 노트북의 Claude Code)에서 붙이고 싶어지면 host publish를 되살리지 말고 router의 [forwards](https://github.com/qwreey/router-docker/blob/HEAD/docs/router.md#forwards--publish)나 App Routes(+tinyauth)로 노출하는 쪽이 "국경은 router만" 원칙과 일관됩니다.

</details>

## Rojo 프로젝트를 Studio에 넣기 (studio-sync)

code-docker 안의 Rojo 프로젝트 폴더에서 `studio-sync`를 실행하면 Studio에 열린 플레이스로 **한 번** 싱크하고 연결을 끊습니다. Studio 쪽 플러그인 클릭이 필요 없어서 에이전트가 직접 쓸 수 있습니다.

```sh
studio-sync                     # default.project.json, owner = git 브랜치 이름
studio-sync path/to/x.project.json --owner my-task --json
studio-sync --release           # 내 owner 표시만 지움(인스턴스는 그대로)
```

```
synced into AgentTestPlace.rbxl as agent-a: +1 ~1 -0
owned: ReplicatedStorage.Shared, ServerScriptService.Server
```

- **프로젝트가 핀한 rojo를 그대로 씁니다.** 싱크하는 동안만 그 프로젝트의 `rojo serve`(mise나 PATH가 고른 버전)를 띄웠다가 끕니다. 저장소에는 아무것도 쓰지 않습니다. Studio 쪽 플러그인은 Rojo 플러그인 원본을 그대로 묶은 것이라 Rojo 프로토콜 5(7.7.0 이상)의 서버와 맞습니다.
- **여러 에이전트가 같은 Studio를 씁니다.** 싱크한 최상위 인스턴스(서비스 바로 아래)에 `AgentOwner` 속성이 붙고, 다른 owner가 붙은 곳을 바꾸게 되는 싱크는 거부됩니다(종료 코드 1). 동시에 실행하면 차례로 처리됩니다. 작업을 끝낸 에이전트는 `studio-sync --release`로 자기 표시를 풀어 다른 에이전트가 이어받게 할 수 있습니다. Studio MCP의 안내문도 에이전트에게 같은 규칙을 알려 줍니다.
- **필요한 것:** Studio가 실행 중이고 플레이스가 열려 있어야 합니다. 플러그인은 `studio` 컨테이너가 부팅할 때 설치되고, Studio는 플러그인을 시작할 때만 읽으므로 처음 한 번은 Studio를 다시 시작해야 합니다. 끄려면 `.env`에 `STUDIO_SYNC_PLUGIN=false`.
- **사람이 쓰는 실시간 싱크**는 지금처럼 Rojo 플러그인으로 하면 됩니다. `rojo serve --address 0.0.0.0`(포트 34872~34879)으로 띄우고 Studio에서 호스트 `roblox-studio-front`로 연결합니다(`roblox-studio-front`가 code-docker로 넘겨줍니다).

## Studio 출력 보기 (studio-output)

code-docker 안의 터미널(VS Code 터미널 등)에서 `studio-output`을 실행하면 Studio의 Output 창 내용을 보여 주고 계속 따라갑니다(`tail -f`처럼). 편집 모드, 플러그인, 플레이테스트의 서버·클라이언트 출력이 모두 나옵니다.

```sh
studio-output                                  # 최근 50줄, 이후 계속 따라감
studio-output -n 200 --no-follow --level warning
```

- Studio 컨테이너 안에서 Studio 로그 파일의 출력 줄(print/warn/error)만 골라 내보냅니다. 로그의 나머지는 컨테이너 밖으로 나가지 않습니다.
- MCP 브리지와 같은 포트·토큰(`studio:8787`, `MCP_TOKEN`)을 거칩니다. `MCP_TOKEN`이 비어 있으면(브리지를 꺼 두면) 쓸 수 없습니다.
- 여러 에이전트가 같은 Studio를 쓰면 모두의 출력이 섞여 나옵니다.

## VS Code에서 `game.Workspace.` 자동완성 (luau-lsp)

luau-lsp VS Code 확장은 Studio의 실제 DataModel을 받아 `game.Workspace.Foo...` 같은 경로를 자동완성할 수 있습니다. 그 데이터를 보내는 Studio 플러그인은 roblox-studio-docker가 이미 설치해 두고, `roblox-studio-front`를 거쳐 code-docker의 3667 포트로 보냅니다.

VS Code(code-server) 쪽에서 할 일:

1. 확장 `JohnnyMorganz.luau-lsp`를 설치합니다(Open VSX).
2. 설정에 `"luau-lsp.studioPlugin.enabled": true`를 넣습니다. 포트는 기본값 3667 그대로 둡니다.
3. VS Code 창이 열려 있으면 Studio 플러그인이 10초 안에 알아서 연결합니다. Studio의 Output에 `[Luau LSP] INFO: Successfully connected`가 보이면 됩니다(`studio-output`으로 확인할 수 있습니다).

- 확장의 서버는 VS Code 창이 열려 있는 동안만 있습니다. 창을 닫았다 열어도 플러그인이 다시 붙습니다.
- 플러그인은 설정을 플레이스마다 `TestService.LuauLSP_Settings` 모듈로 만들어 둡니다(업스트림 동작). 이 모듈은 플레이스와 함께 저장되고 호스트가 `roblox-studio-front`로 들어가 있으니, 이 환경 밖으로 가져가는 플레이스에서는 지워도 됩니다.
- 끄려면 `.env`에 `STUDIO_LUAU_LSP_PLUGIN=false`.

## 격리 구조

읽지 않아도 쓰는 데 지장은 없지만, 왜 이렇게 생겼는지 궁금하거나 네트워크를 손볼 일이 있다면 참고하세요.

<details>
<summary>VNC 전용 네트워크와 "국경은 router만"</summary>

roblox-studio-docker는 VNC 포트(5900)를 host에 게시하지 않고, `router`만 접근 가능한 별도 `internal: true` 네트워크(`roblox-studio-vnc`)에 올립니다. code-docker/dind - 임의 웹브라우징 + npm/pip 설치 + MCP 툴콜을 하는, 상대적으로 신뢰 수준이 낮은 에이전트 컨테이너 - 는 이 네트워크에 **아예 붙지 못합니다**. code-docker가 바깥으로 나갈 때 반드시 router를 거치는 것과 같은 원칙을 VNC 접근에도 적용한 것입니다.

</details>

<details>
<summary>Studio의 작업망과 <code>roblox-studio-front</code></summary>

Studio는 `code-docker-internal`에 붙지 않습니다. 작업망 `roblox-studio-net`(`internal: true`)과 VNC 전용 `roblox-studio-vnc`에만 있고, 작업망에는 router(게이트웨이)와 중계 컨테이너 `roblox-studio-front`만 같이 있습니다.

```
[roblox-studio-net]                            [code-docker-internal]
studio ──▶ roblox-studio-front:34872-34881, :3667 ──▶ code-docker (같은 포트)
studio ◀── roblox-studio-front (별칭 studio)      ◀── code-docker → studio:8787 (MCP)
```

- **이유:** Studio는 플러그인이나 스크립트가 `HttpService`로 헤더까지 마음대로 정한 요청을 보낼 수 있는 컨테이너입니다. `code-docker-internal`에 붙어 있으면 code-docker의 nginx(로그인 없는 code-server, 기본값으로 로그인 없는 webmanager)와 인증 없는 `dind:2375`에 그대로 닿습니다. 툴박스 플러그인이나 모델 하나가 곧 code-docker 탈취 경로가 됩니다.
- **넘어가는 것:** code-docker → Studio는 MCP(8787) 하나, Studio → code-docker는 `STUDIO_CODE_DOCKER_PORTS`(`.env`, 기본 `34872-34881 3667`)뿐입니다. 34872~34879는 일반 `rojo serve`, 34880~34881은 [studio-sync](#rojo-프로젝트를-studio에-넣기-studio-sync), 3667은 luau-lsp Studio 플러그인용입니다. 공백으로 구분하고 범위는 `시작-끝`으로 씁니다. 바꾼 뒤엔 `docker compose up -d roblox-studio-front`.
- **Studio 쪽 플러그인의 호스트는 `roblox-studio-front`입니다.** Rojo 플러그인이나 luau-lsp 플러그인에서 code-docker의 서버에 붙을 때 호스트를 `roblox-studio-front`로 두면, 같은 포트로 code-docker에 넘겨줍니다. Studio 망에서 `roblox-studio-front`에 `code-docker`라는 별칭을 주지 않는 건 router도 그 망에 있어서, router가 `code-docker`를 찾을 때 `roblox-studio-front`로 잘못 풀릴 수 있기 때문입니다.
- **code-docker 쪽 서버는 컨테이너 바깥에서 받아야 합니다.** `rojo serve --address 0.0.0.0`처럼 루프백이 아닌 주소에 바인딩해야 `roblox-studio-front`가 닿습니다.
- **그 밖의 길은 없습니다.** Studio에서 code-docker의 80·82 포트, dind, router 앞문으로 가는 연결은 거부되거나(이름이 `roblox-studio-front`로 풀리고 그 포트를 안 들음) router에서 버려집니다(IP로 직접).

</details>

<details>
<summary>DOCKER-USER 방화벽 예외와 <code>PREFIX</code></summary>

`roblox-studio-vnc`와 `roblox-studio-net`이 `code-docker-internal`이 아닌 별도 네트워크이기 때문에, 최신 Docker Engine의 `DOCKER-USER`/`DOCKER-INTERNAL` 하드닝이 router의 forward 트래픽을 막습니다. 그 예외 규칙은 roblox-studio-docker 자신의 오버레이가 라벨로 직접 선언합니다:

```yaml
networks:
  roblox-studio-vnc:
    labels:
      netinit.provider: "${PREFIX:-}code-docker-netinit-docker"
      netinit.exempt-forward: "true"
```

`code-docker-netinit-docker`가 이 라벨을 보고 `code-docker-internal`과 같은 예외를 걸어줍니다 - code-docker 쪽 `.env`는 건드릴 필요가 없습니다. (예전에는 `.env`의 `NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS`에 네트워크 이름을 나열해야 했습니다. 아직 라벨로 옮기지 않은 배포를 위한 호환 경로로 남아있지만 **DEPRECATED**이고, 그 값을 읽으면 경고를 로그로 남깁니다. 설계 배경은 `.claude/archive/netinit-docker-plan-done.md`.)

네트워크 이름과 컨테이너 이름 모두 오버레이 쪽에서 `${PREFIX:-}`를 달고 정의됩니다 - `PREFIX`가 다른 code-docker 인스턴스 두 개가 각자 roblox-studio-docker를 연동해도 이름이 안 겹치게 하기 위해서입니다. 위 `netinit.provider` 라벨 값도 같은 파일 안에서 같은 `PREFIX`를 참조하므로 자동으로 일치합니다.

</details>

<details>
<summary>기본 라우트는 누가 심는가 (사이드카가 사라진 이유)</summary>

`studio`는 `netinit.provider` 라벨 하나로 `code-docker-netinit-docker`에 옵트인하고, 기본 라우트는 **호스트 쪽 에이전트가 컨테이너 밖에서** 심어줍니다 - `studio` 자신은 `NET_ADMIN`을 갖지 않습니다. 그래서 `studio` 하나만 단독으로 재생성해도 안전합니다.

예전에는 `studio-netinit` 사이드카가 `network_mode: service:studio`로 네트워크 네임스페이스를 공유했는데, 컴포즈가 그 연결을 대상의 **컨테이너 ID에 고정**해서 저장하는 탓에 `studio`가 재생성될 때마다 사이드카가 영구히 고아가 됐습니다 - `studio`는 계속 `Up`인데 라우트만 없는 채로, 사이드카는 `docker ps`에도 안 보이는 상태로요. 자세한 경위는 `.claude/archive/netinit-docker-plan-done.md`.

호스트 에이전트는 컨테이너가 뜬 *뒤에만* 라우트를 심을 수 있으므로, `studio`의 `entrypoint.sh`는 `NETINIT_WAIT=true`일 때(통합 오버레이가 켭니다 - 단독 실행 기본값은 `false`) 기본 라우트가 생길 때까지 기다린 뒤 워크로드를 시작합니다. fail-closed입니다 - `NETINIT_WAIT_TIMEOUT`(기본 60초) 안에 안 생기면 그냥 진행하지 않고 종료해서 `restart: unless-stopped`가 재시도하게 합니다.

</details>

## 문제가 생기면

- **먼저 `docker compose config`** 로 오버레이가 실제로 병합됐는지(서비스 목록에 `studio`가 보이는지) 확인하세요.
- **인터넷이 안 되거나 `studio`가 재시작을 반복** - `docker compose exec studio ip route show default`가 router를 가리켜야 합니다. 아니라면 `code-docker-netinit-docker`가 `studio`를 못 찾은 것입니다. `netinit.provider` 라벨 값이 실제 `PREFIX`까지 포함해서 `code-docker-netinit-docker` 컨테이너 이름과 정확히 일치하는지 보세요. `NETINIT_WAIT=true`면 라우트가 없는 동안 `studio`가 재시작을 반복하고(fail-closed), `docker compose logs studio`에 대기 타임아웃이 남습니다.
- **Studio가 `Temporary failure in name resolution`으로 시작 실패** - DNS 문제입니다. `internal: true` 네트워크의 컨테이너는 Docker 내장 DNS(`127.0.0.11`)가 모르는 이름에 즉시 **확정** SERVFAIL을 돌려주기 때문에 외부 이름을 하나도 못 찾습니다. 그래서 `studio`는 `dns-local`(strict-order dnsmasq)을 함께 띄웁니다. `docker compose exec studio cat /etc/resolv.conf`가 `nameserver 127.0.0.1`이 아니라면 그게 안 떴거나 꺼진 것입니다 - `supervisorctl status dns-local`과 로그를 보세요. 2026-08-27에 추가됐으므로 그 이전 이미지라면 `docker compose build studio && docker compose up -d studio`로 다시 빌드하세요(`up -d`만으로는 이미 있는 이미지를 다시 빌드하지 않습니다).
- **router에서 `target host ... is not in the allowed target host list`** - `.env.router`의 `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`에 `roblox-studio-vnc`가 있는지 확인하세요. `.env`가 아니라 `.env.router`이고, 고친 뒤 router 컨테이너를 재시작해야 반영됩니다. 컨테이너는 정상적으로 뜨기 때문에 다른 증상이 없습니다.
- **예전에 `vnc-only:5900`(또는 `:6080`)으로 등록한 VNC 대상/forward가 연결 안 됨** - 별칭이 `roblox-studio-vnc`로 바뀌었습니다(2026-09-22). VNC 탭에서 그 대상을 편집해 호스트를 `roblox-studio-vnc`로 바꾸고, Net 관리의 forward도 마찬가지로 고치세요. `migrate.sh`가 allowlist에 새 이름을 더해 주므로 `.env.router`는 따로 손댈 필요가 없습니다(남아 있는 `vnc-only`는 지워도 됩니다).
- **forward를 추가했는데 접속이 안 됨** - `code-docker-netinit-docker` 로그에서 `roblox-studio-vnc`에 대한 DOCKER-USER 예외가 실제로 걸렸는지 보세요. 그 네트워크에 `netinit.exempt-forward: "true"` 라벨이 있는지가 가장 흔한 원인입니다.
- **Studio의 Rojo(또는 luau-lsp) 플러그인이 연결 안 됨** - 플러그인의 호스트가 `code-docker`가 아니라 `roblox-studio-front`인지 먼저 보세요(Studio 망에는 `code-docker`라는 이름이 없습니다). 그다음 포트가 `STUDIO_CODE_DOCKER_PORTS` 안에 있는지(`docker compose logs roblox-studio-front` 첫 줄에 넘기는 포트가 나옵니다), code-docker 쪽 서버가 루프백이 아닌 주소에 바인딩했는지(`rojo serve --address 0.0.0.0`) 보세요. `docker compose exec studio curl -s http://roblox-studio-front:34872/api/rojo`로 Studio 쪽에서 직접 확인할 수 있습니다.
- **`studio-sync`가 `no Studio picked this up`으로 끝남** - Studio가 플레이스를 연 상태인지, 플러그인이 설치됐는지(`docker compose exec studio cat /var/log/studio-plugins/stdout.log`), 설치 뒤 Studio를 다시 시작했는지 보세요. Studio 쪽 플러그인이 `code-docker`에 HTTP를 보내도 되는지 묻는 창이 VNC에 떠 있을 수도 있습니다.
- **MCP가 연결 안 됨** - 순서대로:

  ```sh
  docker compose exec studio supervisorctl status mcp-bridge
  docker compose exec studio tail -50 /var/log/mcp-bridge/stdout.log
  ```

  `Child exited: code=127`이 반복되면 그 윗줄이 원인을 말해줍니다 - `StudioMCP.exe not found`는 위 2번 Studio 안 토글을 아직 안 켠 것이고, `wine: not found`는 roblox-studio-docker 쪽 문제입니다(2026-08-29 수정됨 - 그 이미지를 `docker compose build studio`로 다시 빌드하세요). **둘 다 브리지는 계속 `RUNNING`이고 `/healthz`도 `ok`를 돌려줍니다** - 인증을 통과한 요청만 갈 곳이 없어져서, 클라이언트에서는 타임아웃으로만 보입니다.

`MCP_TOKEN not set — idling`이면 토큰이 컨테이너까지 안 들어간 것(`.env`만 고치고 recreate를 안 한 경우가 대부분 - `docker compose up -d studio code-docker`). `StudioMCP.exe not found`가 반복되면 위 2번 Studio 안 토글을 아직 안 켠 것입니다. `npm ERR!`가 보이면 브리지가 실행 시점에 받아오는 `npx -y supergateway`가 실패한 것으로, egress가 막힌 상태에서 컨테이너를 recreate했을 때 그렇습니다(npm 캐시가 볼륨에 없어 recreate마다 다시 받습니다).

  브리지가 멀쩡한데도 안 되면 code-docker 쪽에서 경로를 확인하세요:

  ```sh
  docker compose exec code-docker curl -s -o /dev/null -w '%{http_code}\n' http://studio:8787/mcp
  # 401 = 정상(caddy가 막는 중), 000/타임아웃 = 네트워크 문제

  docker compose exec code-docker sh -c 'curl -s -H "Authorization: Bearer $MCP_TOKEN" http://studio:8787/healthz'
  # ok = caddy→supergateway 정상, unauthorized = 양쪽 토큰 불일치(한쪽만 recreate했을 때)
  ```
