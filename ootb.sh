#!/bin/bash
# ootb.sh - code-docker "out of the box" 원클릭 초기 설치 스크립트.
#
# 사용법: docs/index.md의 클론 절차(레포를 builds/code-docker로 클론)를 그대로
# 따른 뒤 `builds/code-docker/ootb.sh`를 실행하면, 그 수동 절차(docker-compose.yml/
# example-env* 복사, .env 값 설정, docker compose build/up)를 대화형으로 대신
# 해줍니다. 여러 번 다시 실행해도 안전하도록 만들어졌습니다 - 이미 존재하는
# .env/.env.webmanager/.env.router는 덮어쓰지 않고 건너뜁니다.
#
# .env/.env.router 값 설정은 ootb-config.sh, 사이드 프로젝트(roblox-studio-docker 등,
# docs/tips/roblox-studio.md 참고) 연동은 ootb-extra.sh에 각각 위임합니다 - 둘 다
# 설치 이후에도(값 재설정, 사이드 프로젝트 나중에 추가) 단독으로 다시 실행할 수
# 있어서, 이 스크립트는 "새로 설치"에만 필요한 부분(파일 복사, build/up)만
# 담당합니다.
#
# 호스트에는 git/docker(compose)/bash/awk/realpath 외에 아무 것도 있다고
# 가정하지 않습니다 (컨테이너 안에서만 쓰는 yq 등은 여기서 쓰지 않습니다).

set -u

# shellcheck disable=SC1091
. "$(realpath "$(dirname "$0")")/ootb-lib.sh"

require_cmds git docker awk realpath

copy_if_missing() {
  src=$1 dst=$2
  if [ -e "$dst" ]; then
    echo "  - 이미 존재: $dst (건너뜀)"
  else
    cp "$src" "$dst"
    echo "  - 생성: $dst"
  fi
}

echo "=== code-docker ootb 설치 ==="
locate_target_dir

echo "=== 기본 파일 복사 ==="
cp "$SCRIPT_DIR/docker-compose.yml" "$TARGET_DIR/docker-compose.yml"
echo "  - 갱신: $TARGET_DIR/docker-compose.yml"
cp "$SCRIPT_DIR/empty-extra-include.yml" "$TARGET_DIR/empty-extra-include.yml"
echo "  - 갱신: $TARGET_DIR/empty-extra-include.yml"
copy_if_missing "$SCRIPT_DIR/example-env" "$TARGET_DIR/.env"
copy_if_missing "$SCRIPT_DIR/example-env.webmanager" "$TARGET_DIR/.env.webmanager"
copy_if_missing "$SCRIPT_DIR/router/example-env.router" "$TARGET_DIR/.env.router"
echo

REL_BUILD_CONTEXT="$(realpath --relative-to="$TARGET_DIR" "$SCRIPT_DIR")"
set_env_var "$TARGET_DIR/.env" BUILD_CONTEXT "\"$REL_BUILD_CONTEXT\""
echo "BUILD_CONTEXT=\"$REL_BUILD_CONTEXT\" 로 설정했습니다."
echo

bash "$SCRIPT_DIR/ootb-config.sh" "$TARGET_DIR"

if confirm "사이드 프로젝트(EXTRA_INCLUDE)를 지금 연동할까요? (roblox-studio-docker 등, 나중에 ootb-extra.sh로도 가능)" n; then
  bash "$SCRIPT_DIR/ootb-extra.sh" "$TARGET_DIR"
fi
echo

cd "$TARGET_DIR" || exit 1

built=0
if confirm "지금 docker compose build를 수행할까요?" y; then
  if docker compose build; then
    built=1
  else
    echo "  ! docker compose build 실패 - 이후 비밀번호 설정 단계는 건너뜁니다."
  fi
fi
echo

if [ "$built" = "1" ]; then
  echo "=== 비밀번호 설정 (선택) ==="
  echo "빌드 후 컨테이너를 실제로 띄우지 않고, 방금 빌드한 이미지로 딱 원하는"
  echo "명령(--hash-password)만 실행해 해시를 만듭니다. (script/entrypoint.sh /"
  echo "router/script/netgate-entrypoint.sh는 CMD를 무시하고 항상 supervisord를"
  echo "띄우므로, --entrypoint로 완전히 우회해서 바이너리를 직접 실행합니다.)"
  if confirm "webmanager 관리자 비밀번호를 지금 설정할까요? (Terminal/File Manager/Logs 등을 잠급니다)" n; then
    printf "Password: "; read -r -s pw1; echo
    printf "Confirm: "; read -r -s pw2; echo
    if [ "$pw1" != "$pw2" ] || [ -z "$pw1" ]; then
      echo "  ! 비밀번호가 비어있거나 일치하지 않아 건너뜁니다."
    else
      hash="$(printf '%s\n' "$pw1" | docker compose run --rm -T \
        --entrypoint /etc/code-docker/webmanager/webmanager code-docker --hash-password)"
      if [ -n "$hash" ]; then
        set_env_var "$TARGET_DIR/.env.webmanager" WEBMANAGER_AUTH_PASSWORD_HASH "'$hash'"
        echo "  - WEBMANAGER_AUTH_PASSWORD_HASH 설정 완료"
      else
        echo "  ! 해시 생성 실패"
      fi
    fi
  fi
  if confirm "router-manager 관리자 비밀번호를 지금 설정할까요?" n; then
    printf "Password: "; read -r -s pw1; echo
    printf "Confirm: "; read -r -s pw2; echo
    if [ "$pw1" != "$pw2" ] || [ -z "$pw1" ]; then
      echo "  ! 비밀번호가 비어있거나 일치하지 않아 건너뜁니다."
    else
      hash="$(printf '%s\n' "$pw1" | docker compose run --rm -T \
        --entrypoint /usr/local/bin/router-manager code-docker-router --hash-password)"
      if [ -n "$hash" ]; then
        set_env_var "$TARGET_DIR/.env.router" ROUTER_MANAGER_AUTH_PASSWORD_HASH "'$hash'"
        echo "  - ROUTER_MANAGER_AUTH_PASSWORD_HASH 설정 완료"
      else
        echo "  ! 해시 생성 실패"
      fi
    fi
  fi
  echo
fi

if confirm "지금 docker compose up -d를 수행할까요?" y; then
  docker compose up -d
else
  echo "나중에 아래 명령으로 직접 띄우세요:"
  echo "  cd $TARGET_DIR && docker compose up -d"
fi

echo
echo "=== 완료 ==="
echo "설치 위치: $TARGET_DIR"
echo "값을 더 바꾸고 싶다면 $TARGET_DIR/.env, .env.webmanager, .env.router를 직접 편집한 뒤"
echo "docker compose up -d 로 재생성하세요."
