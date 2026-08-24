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
#   OOTB_ENV_TARGET=".env"                                  # 선택, 기본 .env
#   OOTB_ENV_PROMPT_1="이름:설명 텍스트:secret|plain"          # 선택, 1부터 번호를 이어서
#   OOTB_ENV_PROMPT_2="이름2:설명 텍스트2:plain"               # 몇 개든 추가 (설명에 공백 가능 -
#                                                            # 공백구분 리스트가 아니라 번호가
#                                                            # 붙은 개별 변수라서 안전함)
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

  manifest="$clone_dir/ootb-manifest.env"
  if [ ! -f "$manifest" ]; then
    echo "  ! $name 에 ootb-manifest.env가 없어 자동 연동을 건너뜁니다."
    echo "    수동 연동 방법은 docs/tips/roblox-studio.md를 참고하세요."
    continue
  fi

  unset OOTB_NAME OOTB_DESCRIPTION OOTB_COMPOSE_INCLUDE OOTB_EXTRA_INTERNAL_NETWORKS OOTB_ENV_TARGET
  for v in $(compgen -v OOTB_ENV_PROMPT_ 2>/dev/null); do unset "$v"; done
  # shellcheck disable=SC1090
  . "$manifest"

  if [ -z "${OOTB_COMPOSE_INCLUDE:-}" ]; then
    echo "  ! $name/ootb-manifest.env에 OOTB_COMPOSE_INCLUDE가 없어 연동을 건너뜁니다."
    continue
  fi

  echo "  - ${OOTB_NAME:-$name} 연동 중..."
  [ -n "${OOTB_DESCRIPTION:-}" ] && echo "    ${OOTB_DESCRIPTION}"

  extra_include="$TARGET_DIR/extra-include.yml"
  if [ ! -s "$extra_include" ]; then
    printf 'include:\n' > "$extra_include"
  fi
  printf '  - path: builds/%s/%s\n' "$name" "$OOTB_COMPOSE_INCLUDE" >> "$extra_include"
  linked_any=1

  if [ -n "${OOTB_EXTRA_INTERNAL_NETWORKS:-}" ]; then
    current="$(get_env_var "$TARGET_DIR/.env" NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS)"
    merged="$(printf '%s %s' "$current" "$OOTB_EXTRA_INTERNAL_NETWORKS" | xargs)"
    set_env_var "$TARGET_DIR/.env" NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS "\"$merged\""
  fi

  env_target="${OOTB_ENV_TARGET:-.env}"
  i=1
  while :; do
    var="OOTB_ENV_PROMPT_$i"
    item="${!var:-}"
    [ -z "$item" ] && break
    pname="$(echo "$item" | cut -d: -f1)"
    pdesc="$(echo "$item" | cut -d: -f2)"
    pkind="$(echo "$item" | cut -d: -f3)"
    if [ "$pkind" = "secret" ]; then
      printf '    %s (%s, 비밀값, 비우면 미설정): ' "$pname" "$pdesc"
      read -r -s pval
      echo
    else
      printf '    %s (%s, 비우면 미설정): ' "$pname" "$pdesc"
      read -r pval
    fi
    [ -n "$pval" ] && set_env_var "$TARGET_DIR/$env_target" "$pname" "\"$pval\""
    i=$((i + 1))
  done
done
if [ "$linked_any" = "1" ]; then
  set_env_var "$TARGET_DIR/.env" EXTRA_INCLUDE "extra-include.yml"
  echo "EXTRA_INCLUDE=extra-include.yml 로 설정했습니다."
fi
