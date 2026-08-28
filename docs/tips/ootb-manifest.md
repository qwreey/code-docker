# ootb-manifest.env: 사이드 프로젝트를 ootb.sh에 연동하기

[`ootb.sh`](../index.md#ootbsh로-한-번에-설치하기)는 roblox-studio-docker 같은,
code-docker와 완전히 독립된 사이드 프로젝트를 `EXTRA_INCLUDE` 훅으로 자동
연동할 수 있습니다 - 단, code-docker 쪽이 그 프로젝트를 미리 알고 있는 게
아니라, **사이드 프로젝트 자신이 레포 루트에 `ootb-manifest.env`라는 파일을
들고 다니는 것**으로 동작합니다. 이 문서는 새로운 사이드 프로젝트를 만들 때
이 파일을 어떻게 작성하면 되는지 다룹니다.

`ootb-manifest.env`가 없는 프로젝트도 `ootb.sh`로 clone은 되지만, 자동
연동(`extra-include.yml` 작성 등)은 건너뛰고 수동 안내만 나옵니다.

## 파일 형식

레포 루트의 `ootb-manifest.env`는 그냥 평범한 shell 변수 대입 파일입니다 -
`ootb.sh`가 `. ootb-manifest.env`로 직접 source합니다 (별도 파서가 없으므로
YAML/JSON이 아니라 이 형식을 씁니다 - `ootb.sh`는 호스트에 `yq`/`jq` 같은
도구가 있다고 가정하지 않습니다). 임의의 쉘 코드를 넣을 수도 있지만, 그러지
말고 아래 변수들만 대입하는 용도로 유지하세요.

```sh
# ootb-manifest.env
OOTB_NAME="Roblox Studio"
OOTB_DESCRIPTION="Wine 기반 Roblox Studio (GPU passthrough + headless Wayland + wayvnc)"
OOTB_COMPOSE_INCLUDE="roblox-studio-code-docker.yml"
OOTB_ROUTER_ALLOWED_TARGET_HOSTS="vnc-only"
OOTB_ENV_PROMPT_1="MCP_TOKEN:code-docker의 Claude Code가 Studio를 조작하는 MCP 브리지:generate"
```

위 예시는 실제 [roblox-studio-docker의 `ootb-manifest.env`](https://github.com/qwreey/roblox-studio-docker/blob/HEAD/ootb-manifest.env)를
줄인 것입니다. `OOTB_EXTRA_INTERNAL_NETWORKS`가 없는 것도, `OOTB_ENV_TARGET`이
없는 것도(기본값 `.env`) 실제 그대로입니다 — 전자는 아래 표에 적힌 대로 라벨로
대체돼 더 이상 필요 없고, 후자는 기본값이면 굳이 적지 않습니다.

| 변수 | 필수 | 설명 |
|---|---|---|
| `OOTB_NAME` | 필수 | 연동 중 진행 메시지에 표시할 이름 |
| `OOTB_DESCRIPTION` | 선택 | 한 줄 설명, 연동 시작 시 같이 출력됨 |
| `OOTB_COMPOSE_INCLUDE` | 필수 | 이 프로젝트 레포 루트 기준 상대경로 - `ootb.sh`가 `extra-include.yml`의 `include:` 목록에 `builds/<repo-이름>/<이 값>`을 추가함 |
| `OOTB_EXTRA_INTERNAL_NETWORKS` | 선택, **DEPRECATED** | 공백구분 네트워크 이름 목록 - `.env`의 `NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS`에 병합됨 (이 프로젝트가 `code-docker-internal`이 아닌 자기만의 `internal: true` 네트워크에 router를 끌어들이는 경우에만 쓰였음 - roblox-studio-docker의 VNC 격리가 그 예시). **이제는 사이드 프로젝트 자신의 compose 오버레이 파일이 그 네트워크에 `netinit.provider`/`netinit.exempt-forward: "true"` 라벨을 직접 다는 쪽을 씁니다** (자세한 라벨 스키마는 [roblox-studio.md](roblox-studio.md)와 `.claude/archive/netinit-docker-plan-done.md` 참고) - 그러면 code-docker 쪽 `.env`를 이 필드로 건드릴 필요 자체가 없어집니다. 이 필드는 아직 라벨로 옮기지 않은 매니페스트를 위한 호환 경로로 한동안 남아있을 뿐이고, `netinit-docker`가 `NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS`를 읽으면 경고 로그를 남깁니다. 새 사이드 프로젝트는 라벨 쪽을 쓰세요. (레거시 병합 동작: 사이드 프로젝트 쪽 compose가 그 네트워크 이름을 `${PREFIX:-}`로 접두사 붙여 정의했다면, 여기서도 값 안에 `${PREFIX}`를 그대로 써서 맞추세요(예: `"${PREFIX}roblox-studio-vnc"`) - `ootb-extra.sh`가 매니페스트를 source하기 전에 code-docker 쪽 `.env`의 현재 `PREFIX` 값을 환경에 내보내므로, 일반 쉘 변수 치환으로 자동으로 풀립니다.) |
| `OOTB_ROUTER_ALLOWED_TARGET_HOSTS` | 선택 | 공백(또는 콤마)구분 호스트네임 목록 - `.env.router`의 `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`에 병합됨(콤마 구분으로 정규화 + 중복 제거). router의 Dev Proxy / App Routes / VNC 탭이 대상으로 삼을 수 있는 호스트는 기본적으로 `code-docker`/`dind` 둘뿐이라(Caddy admin API 등을 겨냥한 self-SSRF 방지), 사이드 프로젝트가 **자기 컨테이너를 프록시 대상으로 노출하려면** 그 컨테이너의 네트워크 별칭을 여기 적어야 합니다 - 안 적으면 컨테이너는 정상적으로 뜨는데 대상 등록만 `target host ...is not in the allowed target host list`로 거부됩니다. **`OOTB_ENV_PROMPT_*`로 물어보지 않고 매니페스트가 값을 직접 선언하는 필드인 이유**: 어떤 호스트네임이 필요한지는 사용자가 알 수 없고 붙는 프로젝트만 알기 때문입니다. 위 `OOTB_EXTRA_INTERNAL_NETWORKS`와 성격이 같은 declarative 필드지만 **그쪽과 달리 Docker 라벨로 대체되지 않습니다** - router-manager는 자기가 보안 경계 컨테이너라서 `docker.sock`을 의도적으로 갖지 않고, 따라서 라벨을 읽을 수단 자체가 없습니다. 또한 보안 경계의 allowlist는 런타임에 바뀌지 않는 정적 인프라 설정으로 두는 편이 옳습니다(같은 이유로 `ROUTER_MANAGER_HOSTS`/`ALLOWED_HOSTS`도 웹 UI에서 못 바꿉니다). |
| `OOTB_ENV_TARGET` | 선택, 기본 `.env` | 아래 `OOTB_ENV_PROMPT_*`로 물어본 값을 어느 env 파일에 쓸지 |
| `OOTB_ENV_PROMPT_1`, `OOTB_ENV_PROMPT_2`, ... | 선택 | `이름:설명:secret\|plain\|generate` 형식, 1부터 번호를 이어서 몇 개든 추가. 없으면 다음 번호에서 중단됩니다. **공백구분 단일 리스트가 아니라 번호 붙은 개별 변수인 이유**: 설명 텍스트에 공백(특히 한글 설명)이 들어가면 셸 word-splitting으로 깨지기 때문입니다 - 각 항목이 독립된 변수라 안전합니다. **설명 텍스트에 `:`은 못 씁니다**(구분자). 종류별 동작은 아래 참고. |

### `OOTB_ENV_PROMPT_*`의 세 가지 종류

| 종류 | 동작 |
|---|---|
| `plain` | 그냥 입력받아 그대로 씁니다. |
| `secret` | 화면에 안 보이게 입력받습니다(`read -s`). 사용자가 **이미 가지고 있는** 값(외부 서비스 API 키 등)에만 쓰세요. |
| `generate` | 값을 묻지 않고 **활성화할지 y/N만** 묻고, 예라면 `openssl rand -hex 32`(없으면 `/dev/urandom` 폴백)로 생성해서 씁니다. 사람이 지어낼 이유가 없는 내부용 토큰 - 컨테이너끼리만 쓰는 통로의 인증값 같은 것 - 에 씁니다. roblox-studio-docker의 `MCP_TOKEN`이 이 경우입니다. |

세 종류 모두 **이미 그 키가 대상 env 파일에 있으면(값이 비어있어도) 다시 묻지
않습니다**. 사용자가 거절하거나 빈 값을 입력한 것도 `KEY=` 형태로 기록해서 남기기
때문에, 같은 질문을 `migrate.sh`를 돌릴 때마다 다시 받는 일이 없습니다. 마음이 바뀌어
나중에 켜고 싶다면(혹은 이미 설정된 값을 바꾸고 싶다면) 그 env 파일의 해당 줄을 직접
채우세요 - `ootb`/`migrate`는 사용자가 이미 답한 값을 절대 덮어쓰지 않습니다.

## 동작 방식 요약

`ootb.sh`가 사이드 프로젝트를 clone한 뒤:

1. `ootb-manifest.env`가 있으면 source (매 프로젝트마다 이전 값들은 초기화됨)
2. `extra-include.yml`이 없거나 비어있으면 새로 만들고, `- path: builds/<이름>/$OOTB_COMPOSE_INCLUDE` 라인을 추가
3. `OOTB_EXTRA_INTERNAL_NETWORKS`가 있으면 기존 `.env`의 값과 합쳐서 다시 씀 (덮어쓰지 않고 병합) - 위 표에 적었듯 DEPRECATED 경로이므로, 새 사이드 프로젝트는 대신 자기 오버레이의 네트워크에 라벨을 직접 답니다
4. `OOTB_ROUTER_ALLOWED_TARGET_HOSTS`가 있으면 기존 `.env.router`의 `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`와 합쳐서 다시 씀 (병합 + 중복 제거)
5. `OOTB_ENV_PROMPT_*`를 순서대로 물어봐서 `$OOTB_ENV_TARGET`에 씀
6. 하나 이상 연동됐으면 마지막에 `.env`의 `EXTRA_INCLUDE=extra-include.yml`을 설정

이미 연동된 프로젝트는 [`migrate.sh`](../index.md#업데이트하기)가 3단계에서 git
pull한 뒤 **3~5번을 다시 반영**합니다 - declarative 필드(3~4)는 값이 바뀌었으면 다시
병합하고, `OOTB_ENV_PROMPT_*`(5)는 **아직 대상 env 파일에 그 키가 아예 없을 때만**
물어봅니다(이미 답한 값은 절대 덮어쓰지 않음). 이 재적용이 없으면 매니페스트에 새
declarative 필드가 생길 때마다 "새로 까는 사람한테만 먹고 기존 배포엔 안 먹는"
상태가 됩니다(실제로
`OOTB_ROUTER_ALLOWED_TARGET_HOSTS`를 추가했을 때 그랬습니다 - 스택은 멀쩡히 뜨는데
router 대상 등록만 조용히 거부됨). 프롬프트 쪽도 같은 격차가 있었습니다 -
roblox-studio-docker의 `MCP_TOKEN`은 처음부터 매니페스트에 있었지만, 최초 연동 때
한 번 묻고 마는 구조라 그때 Enter로 넘겼거나 그 전에 수동 연동한 배포에는
**나중에 설정할 경로가 사실상 없었습니다**(같은 git URL을 `ootb-extra.sh`에 다시
입력하는 비공식 우회밖에 없었음). 병합은 전부 additive + 중복 제거라 몇 번을 돌려도
결과가 같고, 실제로 값이 바뀐 항목만 출력됩니다. `extra-include.yml`에 등록돼 있는
프로젝트만 대상입니다 - `builds/` 아래에 클론만 해두고 아직 안 붙인 프로젝트까지
router allowlist를 넓혀주면 안 되기 때문입니다.

두 진입점(`ootb-extra.sh`, `migrate-continue.sh`)이 쓰는 실제 구현은 `ootb-lib.sh`의
`load_manifest` + `apply_manifest_declarative` + `apply_manifest_prompts` 세 함수입니다
- **새 필드를 추가할 때는 그 함수들만 고치면 양쪽에 동시에 반영됩니다.** 프로젝트가
값을 직접 선언하는 필드는 `apply_manifest_declarative`에, 사람에게 물어야 하는 필드는
`apply_manifest_prompts`에 넣으세요.

## 참고

- 실제 예시는 [roblox-studio-docker](https://github.com/qwreey/roblox-studio-docker)의
  `ootb-manifest.env`와 [roblox-studio.md](roblox-studio.md)를 참고하세요.
- `ootb.sh`가 이 파일을 신뢰하고 그대로 실행한다는 점(`git clone`한 임의의
  Dockerfile을 `docker compose build`가 빌드하는 것과 같은 신뢰 수준)을
  기억하세요 - 사용자가 이미 그 URL을 직접 입력해 clone하기로 선택했다는 전제입니다.
- `migrate.sh`(기존 배포 업데이트 스크립트, [index.md](../index.md#업데이트하기))는
  `builds/` 아래 사이드 프로젝트를 git pull하고 위에서 설명한 declarative 필드와
  아직 답하지 않은 프롬프트를 다시 반영해줍니다. 다만 **사이드 프로젝트 자신의 env 마이그레이션**은 아직 안
  해줍니다 - webmanager/router-manager처럼 자기만의 `--env-migrate` CLI를 갖춘
  사이드 프로젝트가 실제로 생기면, 이 매니페스트에
  `OOTB_ENVMIGRATE_BIN`/`OOTB_ENVMIGRATE_SERVICE` 같은 필드를 추가해 확장할 수
  있을 것입니다 - 지금은 실제로 쓰는 곳이 없어 구현하지 않았습니다.
- code-docker 쪽 `.env`/`.env.router`에 병합된 값은 그 뒤 `migrate.sh` 4단계의
  `--env-migrate`를 거쳐도 그대로 유지됩니다(템플릿의 주석 처리된 기본값보다 사용자가
  실제로 설정한 값이 우선 - `envmigrate`의 동작, `#!important` 강제 키가 아닌 한).
