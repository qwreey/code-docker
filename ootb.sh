#!/bin/bash
# ootb.sh - code-docker "out of the box" 원클릭 초기 설치 스크립트.
#
# 사용법: docs/index.md의 클론 절차(레포를 builds/code-docker로 클론)를 그대로
# 따른 뒤 `builds/code-docker/ootb.sh`를 실행하면, 그 수동 절차(docker-compose.yml/
# example-env* 복사, .env 값 설정, docker compose build/up)를 대화형으로 대신
# 해줍니다. 여러 번 다시 실행해도 안전하도록 만들어졌습니다 - 이미 존재하는
# .env/.env.webmanager/.env.router는 덮어쓰지 않고 건너뜁니다.
#
# 사이드 프로젝트 연동(roblox-studio-docker 등, docs/tips/roblox-studio.md 참고)도
# 이 스크립트가 대화형으로 clone + extra-include.yml 작성까지 해줍니다 - 단,
# code-docker가 특정 사이드 프로젝트를 알 필요가 없도록 범용 메커니즘으로
# 동작합니다: 각 사이드 프로젝트가 자기 레포 루트에 `ootb-manifest.env`라는
# plain shell env 파일을 들고 있으면 그걸 읽어 자동 연동하고, 없으면 클론만 하고
# 건너뜁니다. 매니페스트 스키마는 docs/tips/ootb-manifest.md 참고, 요약하면:
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
# 호스트에는 git/docker(compose)/bash/awk/realpath 외에 아무 것도 있다고
# 가정하지 않습니다 (컨테이너 안에서만 쓰는 yq 등은 여기서 쓰지 않습니다).

set -u

for cmd in git docker awk realpath; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ootb.sh: '$cmd' 명령을 찾을 수 없습니다. 설치 후 다시 실행하세요." >&2
    exit 1
  fi
done

SCRIPT_DIR="$(realpath "$(dirname "$0")")"
if [ ! -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  echo "ootb.sh: $SCRIPT_DIR 에서 docker-compose.yml을 찾을 수 없습니다 - code-docker 레포 안에서 실행 중인지 확인하세요." >&2
  exit 1
fi

DEFAULT_TARGET_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

confirm() {
  # confirm "질문" [기본값 y|n]
  default=${2:-y}
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  printf '%s %s ' "$1" "$hint"
  read -r ans
  [ -z "$ans" ] && ans=$default
  case "$ans" in
    [yY]*) return 0 ;;
    *) return 1 ;;
  esac
}

set_env_var() {
  # set_env_var <file> <key> <raw_value>  - 기존 (주석 처리됐든 아니든) 라인을
  # 찾아 교체하거나, 없으면 파일 끝에 추가. sed 대신 awk -v를 쓰는 이유는
  # <raw_value>에 argon2 해시처럼 sed 치환 특수문자($, &, |, \)가 그대로
  # 들어있을 수 있어서 - awk -v로 넘긴 값은 정규식/백레퍼런스로 재해석되지
  # 않고 문자열 그대로 print된다.
  file=$1 key=$2 value=$3
  touch "$file"
  awk -v k="$key" -v v="$value" '
    $0 ~ "^#?" k "=" { print k "=" v; done=1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$file.ootb.tmp" && mv "$file.ootb.tmp" "$file"
}

get_env_var() {
  file=$1 key=$2
  val=$(grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2-)
  val=${val%\"}; val=${val#\"}
  val=${val%\'}; val=${val#\'}
  printf '%s' "$val"
}

copy_if_missing() {
  src=$1 dst=$2
  if [ -e "$dst" ]; then
    echo "  - 이미 존재: $dst (건너뜀)"
  else
    cp "$src" "$dst"
    echo "  - 생성: $dst"
  fi
}

prompt_set() {
  # prompt_set <file> <key> <프롬프트 텍스트> - 값을 큰따옴표로 감싸 저장
  # (example-env류가 이미 쓰는 관례: PREFIX="", TZ="", ... 형태).
  file=$1 key=$2 prompt=$3
  printf '%s: ' "$prompt"
  read -r val
  [ -n "$val" ] && set_env_var "$file" "$key" "\"$val\""
}

echo "=== code-docker ootb 설치 ==="
echo "설치 대상 디렉터리(기본값): $DEFAULT_TARGET_DIR"
printf "다른 경로를 쓰려면 입력하세요 (Enter면 위 기본값 사용): "
read -r custom_target
if [ -n "$custom_target" ]; then
  TARGET_DIR="$(realpath -m "$custom_target")"
else
  TARGET_DIR="$DEFAULT_TARGET_DIR"
fi
mkdir -p "$TARGET_DIR"
echo "-> $TARGET_DIR 에 설치합니다."
echo

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

echo "=== 기본 환경 값 설정 (Enter로 기본값 유지) ==="
prompt_set "$TARGET_DIR/.env" PREFIX "여러 인스턴스를 한 호스트에 띄울 때 붙일 접두사 (PREFIX)"
prompt_set "$TARGET_DIR/.env" TZ "타임존 (예: Asia/Seoul, 비우면 UTC)"
prompt_set "$TARGET_DIR/.env" CODE_CPU_LIMIT "code-docker CPU 제한 (예: 4, 비우면 무제한)"
prompt_set "$TARGET_DIR/.env" CODE_MEM_LIMIT "code-docker 메모리 제한 (예: 4g, 비우면 무제한)"
prompt_set "$TARGET_DIR/.env" DIND_CPU_LIMIT "code-docker-dind CPU 제한 (비우면 무제한)"
prompt_set "$TARGET_DIR/.env" DIND_MEM_LIMIT "code-docker-dind 메모리 제한 (비우면 무제한)"
prompt_set "$TARGET_DIR/.env" ROUTER_CPU_LIMIT "code-docker-router CPU 제한 (비우면 무제한)"
prompt_set "$TARGET_DIR/.env" ROUTER_MEM_LIMIT "code-docker-router 메모리 제한 (비우면 무제한)"
echo

echo "=== 추가 프로젝트 연동 (선택, 없으면 그냥 Enter) ==="
echo "roblox-studio-docker 등 EXTRA_INCLUDE로 붙일 사이드 프로젝트의 git URL을"
echo "입력하세요. 여러 개 등록 가능, 빈 값을 입력하면 다음 단계로 넘어갑니다."
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
