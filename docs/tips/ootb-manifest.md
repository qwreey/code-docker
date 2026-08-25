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
OOTB_EXTRA_INTERNAL_NETWORKS="roblox-studio-vnc"
OOTB_ENV_TARGET=".env"
OOTB_ENV_PROMPT_1="VNC_PASSWORD:VNC 접속 비밀번호(선택, 비우면 미설정):secret"
```

| 변수 | 필수 | 설명 |
|---|---|---|
| `OOTB_NAME` | 필수 | 연동 중 진행 메시지에 표시할 이름 |
| `OOTB_DESCRIPTION` | 선택 | 한 줄 설명, 연동 시작 시 같이 출력됨 |
| `OOTB_COMPOSE_INCLUDE` | 필수 | 이 프로젝트 레포 루트 기준 상대경로 - `ootb.sh`가 `extra-include.yml`의 `include:` 목록에 `builds/<repo-이름>/<이 값>`을 추가함 |
| `OOTB_EXTRA_INTERNAL_NETWORKS` | 선택, **DEPRECATED** | 공백구분 네트워크 이름 목록 - `.env`의 `NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS`에 병합됨 (이 프로젝트가 `code-docker-internal`이 아닌 자기만의 `internal: true` 네트워크에 router를 끌어들이는 경우에만 쓰였음 - roblox-studio-docker의 VNC 격리가 그 예시). **이제는 사이드 프로젝트 자신의 compose 오버레이 파일이 그 네트워크에 `netinit.provider`/`netinit.exempt-forward: "true"` 라벨을 직접 다는 쪽을 씁니다** (자세한 라벨 스키마는 [roblox-studio.md](roblox-studio.md)와 `.claude/archive/netinit-docker-plan-done.md` 참고) - 그러면 code-docker 쪽 `.env`를 이 필드로 건드릴 필요 자체가 없어집니다. 이 필드는 아직 라벨로 옮기지 않은 매니페스트를 위한 호환 경로로 한동안 남아있을 뿐이고, `netinit-docker`가 `NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS`를 읽으면 경고 로그를 남깁니다. 새 사이드 프로젝트는 라벨 쪽을 쓰세요. (레거시 병합 동작: 사이드 프로젝트 쪽 compose가 그 네트워크 이름을 `${PREFIX:-}`로 접두사 붙여 정의했다면, 여기서도 값 안에 `${PREFIX}`를 그대로 써서 맞추세요(예: `"${PREFIX}roblox-studio-vnc"`) - `ootb-extra.sh`가 매니페스트를 source하기 전에 code-docker 쪽 `.env`의 현재 `PREFIX` 값을 환경에 내보내므로, 일반 쉘 변수 치환으로 자동으로 풀립니다.) |
| `OOTB_ENV_TARGET` | 선택, 기본 `.env` | 아래 `OOTB_ENV_PROMPT_*`로 물어본 값을 어느 env 파일에 쓸지 |
| `OOTB_ENV_PROMPT_1`, `OOTB_ENV_PROMPT_2`, ... | 선택 | `이름:설명:secret\|plain` 형식, 1부터 번호를 이어서 몇 개든 추가. 없으면 다음 번호에서 중단됩니다. **공백구분 단일 리스트가 아니라 번호 붙은 개별 변수인 이유**: 설명 텍스트에 공백(특히 한글 설명)이 들어가면 셸 word-splitting으로 깨지기 때문입니다 - 각 항목이 독립된 변수라 안전합니다. `secret`이면 화면에 안 보이게 입력받습니다(`read -s`). 사용자가 빈 값을 입력하면 그 키는 그냥 건너뜁니다(주석 상태 유지). |

## 동작 방식 요약

`ootb.sh`가 사이드 프로젝트를 clone한 뒤:

1. `ootb-manifest.env`가 있으면 source (매 프로젝트마다 이전 값들은 초기화됨)
2. `extra-include.yml`이 없거나 비어있으면 새로 만들고, `- path: builds/<이름>/$OOTB_COMPOSE_INCLUDE` 라인을 추가
3. `OOTB_EXTRA_INTERNAL_NETWORKS`가 있으면 기존 `.env`의 값과 합쳐서 다시 씀 (덮어쓰지 않고 병합) - 위 표에 적었듯 DEPRECATED 경로이므로, 새 사이드 프로젝트는 대신 자기 오버레이의 네트워크에 라벨을 직접 답니다
4. `OOTB_ENV_PROMPT_*`를 순서대로 물어봐서 `$OOTB_ENV_TARGET`에 씀
5. 하나 이상 연동됐으면 마지막에 `.env`의 `EXTRA_INCLUDE=extra-include.yml`을 설정

## 참고

- 실제 예시는 [roblox-studio-docker](https://github.com/qwreey/roblox-studio-docker)의
  `ootb-manifest.env`와 [roblox-studio.md](roblox-studio.md)를 참고하세요.
- `ootb.sh`가 이 파일을 신뢰하고 그대로 실행한다는 점(`git clone`한 임의의
  Dockerfile을 `docker compose build`가 빌드하는 것과 같은 신뢰 수준)을
  기억하세요 - 사용자가 이미 그 URL을 직접 입력해 clone하기로 선택했다는 전제입니다.
- `migrate.sh`(기존 배포 업데이트 스크립트, [index.md](../index.md#업데이트하기))는
  `builds/` 아래 사이드 프로젝트를 git pull까지만 해주고, 사이드 프로젝트 자신의
  env 마이그레이션은 아직 안 해줍니다 - webmanager/router-manager처럼 자기만의
  `--env-migrate` CLI를 갖춘 사이드 프로젝트가 실제로 생기면, 이 매니페스트에
  `OOTB_ENVMIGRATE_BIN`/`OOTB_ENVMIGRATE_SERVICE` 같은 필드를 추가해 확장할 수
  있을 것입니다 - 지금은 실제로 쓰는 곳이 없어 구현하지 않았습니다.
