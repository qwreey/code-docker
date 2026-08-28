#!/bin/bash
# ootb-extra.sh - roblox-studio-docker 같은, EXTRA_INCLUDE로 붙이는 완전 독립
# 사이드 프로젝트를 clone + 연동합니다. 처음 설치할 때(ootb.sh가 물어보고
# 서브프로세스로 호출) 뿐 아니라, 이미 설치된 배포에 나중에 새 사이드 프로젝트를
# 추가하고 싶을 때(migrate.sh가 물어보고 호출, 또는 그냥 이 스크립트를 직접
# 실행)도 씁니다.
#
#   builds/code-docker/ootb-extra.sh
#
# 각 사이드 프로젝트가 자기 레포 루트에 들고 다니는 `ootb-manifest.env` 매니페스트를
# 읽어 자동 연동합니다 - code-docker는 어떤 사이드 프로젝트가 있는지 전혀
# 모릅니다. 매니페스트 스키마는 docs/tips/ootb-manifest.md 참고, 요약하면:
#
#   OOTB_NAME="표시 이름"                                   # 필수
#   OOTB_DESCRIPTION="한 줄 설명"                            # 선택
#   OOTB_COMPOSE_INCLUDE="상대/경로/overlay.yml"             # 필수 (레포 루트 기준)
#   OOTB_EXTRA_INTERNAL_NETWORKS="네트워크1 네트워크2"        # 선택
#   OOTB_ROUTER_ALLOWED_TARGET_HOSTS="호스트1 호스트2"        # 선택
#   OOTB_ENV_TARGET=".env"                                  # 선택, 기본 .env
#   OOTB_ENV_PROMPT_1="이름:설명 텍스트:secret|plain|generate" # 선택, 1부터 번호를 이어서
#   OOTB_ENV_PROMPT_2="이름2:설명 텍스트2:plain"               # 몇 개든 추가 (설명에 공백 가능 -
#                                                            # 공백구분 리스트가 아니라 번호가
#                                                            # 붙은 개별 변수라서 안전함)
#
# OOTB_ENV_PROMPT_* 를 실제로 물어보는 건 ootb-lib.sh의 apply_manifest_prompts고,
# migrate-continue.sh도 (이미 연동된 배포에 아직 값이 없는 키에 한해) 같은 함수를
# 부릅니다 - 그래서 "새로 까는 사람한테만 물어보고 기존 배포엔 영영 안 물어보는"
# 격차가 없습니다. declarative 필드가 apply_manifest_declarative 하나로 모여있는
# 것과 같은 이유입니다.
#
# 인자로 TARGET_DIR을 주면(ootb.sh/migrate.sh가 이렇게 호출) 위치를 다시 안
# 묻고 바로 그 디렉터리를 씁니다 - 인자가 없으면 대화형으로 확인합니다.

set -u

# shellcheck disable=SC1091
. "$(realpath "$(dirname "$0")")/ootb-lib.sh"

require_cmds git awk realpath

resolve_target_dir "${1:-}"

echo "roblox-studio-docker 등 EXTRA_INCLUDE로 붙일 사이드 프로젝트의 git URL을"
echo "입력하세요. 여러 개 등록 가능, 빈 값을 입력하면 종료합니다."
linked_any=0
while :; do
  printf "추가 프로젝트 git URL: "
  read -r url
  [ -z "$url" ] && break

  name="$(basename "$url" .git)"
  clone_dir="$TARGET_DIR/builds/$name"
  if [ -d "$clone_dir" ]; then
    echo "  - 이미 클론됨: $clone_dir (건너뜀)"
  else
    if ! git clone "$url" "$clone_dir"; then
      echo "  ! 클론 실패, 이 프로젝트는 건너뜁니다."
      continue
    fi
  fi

  if [ ! -f "$clone_dir/ootb-manifest.env" ]; then
    echo "  ! $name 에 ootb-manifest.env가 없어 자동 연동을 건너뜁니다."
    echo "    수동 연동 방법은 docs/tips/roblox-studio.md를 참고하세요."
    continue
  fi
  # 매니페스트를 읽고 declarative 필드를 반영하는 로직 자체는 ootb-lib.sh에 있다 -
  # migrate-continue.sh가 이미 연동된 프로젝트를 git pull한 뒤 같은 함수를 다시
  # 부르기 때문(그 함수의 주석 참고).
  if ! load_manifest "$clone_dir"; then
    echo "  ! $name 자동 연동을 건너뜁니다."
    continue
  fi

  echo "  - ${OOTB_NAME:-$name} 연동 중..."
  [ -n "${OOTB_DESCRIPTION:-}" ] && echo "    ${OOTB_DESCRIPTION}"

  extra_include="$TARGET_DIR/extra-include.yml"
  if [ ! -s "$extra_include" ]; then
    printf 'include:\n' > "$extra_include"
  fi
  # 이미 같은 경로가 들어있으면 다시 붙이지 않는다 - 이미 클론된 프로젝트에
  # 이 스크립트를 다시 돌리는 건(매니페스트가 새 declarative 필드를 들고 왔을 때)
  # 정상적인 사용 경로라서 매번 줄이 하나씩 늘면 곤란하다. compose 자체는 같은
  # 파일을 두 번 include해도 서비스/네트워크를 이름 기준으로 병합해서 실질적인
  # 문제는 없지만(실측 확인), 파일이 지저분해질 이유가 없다.
  include_line="  - path: builds/$name/$OOTB_COMPOSE_INCLUDE"
  if grep -qxF "$include_line" "$extra_include"; then
    echo "    (extra-include.yml에 이미 등록돼 있어 그대로 둡니다)"
  else
    printf '%s\n' "$include_line" >> "$extra_include"
  fi
  linked_any=1

  apply_manifest_declarative

  apply_manifest_prompts
done
if [ "$linked_any" = "1" ]; then
  set_env_var "$TARGET_DIR/.env" EXTRA_INCLUDE "extra-include.yml"
  echo "EXTRA_INCLUDE=extra-include.yml 로 설정했습니다."
fi
