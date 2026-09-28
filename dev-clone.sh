#!/bin/bash
# dev-clone.sh - code-docker를 개발할 때 같이 만지는 형제 repo들을 이 체크아웃
# 안으로 받아옵니다. 다시 실행하면 이미 받은 것들을 최신으로 pull합니다.
#
#   ./dev-clone.sh                 # 전부
#   ./dev-clone.sh code-docker-chrome router-docker-client   # 골라서
#
# 두 디렉터리로 나뉩니다 (둘 다 gitignore, 각자 독립 git repo):
#   builds/<name>  EXTRA_INCLUDE로 스택에 합류하는 provider. 실제 배포에서
#                  ootb-extra.sh가 clone하는 위치와 같은 모양이라, 여기서 쓰는
#                  extra-include.yml이 배포의 것과 한 글자도 다르지 않습니다.
#   dev/<name>     원격 참조(remote-git build context 등)로 쓰는 코어 의존물의
#                  로컬 체크아웃. .env로 빌드가 이쪽을 보게 바꿔야 의미가 있습니다.
#
# .env와 extra-include.yml은 직접 고치지 않고, 넣을 줄을 마지막에 출력만 합니다
# - 둘 다 사용자 소유 파일이고, 여기서 받았다고 해서 전부 스택에 붙이고 싶은
# 건 아닐 수 있습니다.
#
# pull은 --ff-only이고, 작업 중인 변경이 있거나 upstream이 없는 브랜치면 건드리지
# 않고 그 이유를 출력합니다.
#
# fetch는 https(키 없이도 받아지게), push는 ssh로 가도록 clone할 때 pushurl을 따로
# 잡아둡니다. DEV_CLONE_GIT_BASE / DEV_CLONE_PUSH_BASE로 각각 바꿀 수 있고,
# DEV_CLONE_PUSH_BASE=""이면 pushurl을 따로 두지 않습니다.
set -u

cd "$(dirname "$0")" || exit 1

GIT_BASE="${DEV_CLONE_GIT_BASE:-https://github.com/qwreey/}"
PUSH_BASE="${DEV_CLONE_PUSH_BASE-git@github.com:qwreey/}"

# <디렉터리> <repo 이름>
REPOS=(
  "builds code-docker-chrome"
  "builds roblox-studio-docker"
  "builds code-docker-trilium"
  "dev router-docker-client"
  "dev router-docker"
  "dev dind-authz-docker"
  "dev code-server-autoinstall"
  "dev envmigrate"
)

failed=0
warn() { printf '  ! %s\n' "$*"; }

sync_repo() {
  local dir=$1 name=$2 path="$1/$2"

  if [ ! -e "$path" ]; then
    printf '%s: clone\n' "$path"
    mkdir -p "$dir"
    if ! git clone --recurse-submodules "$GIT_BASE$name.git" "$path"; then
      warn "clone 실패 ($GIT_BASE$name.git)"
      failed=1
    elif [ -n "$PUSH_BASE" ]; then
      git -C "$path" remote set-url --push origin "$PUSH_BASE$name.git"
    fi
    return
  fi

  if ! git -C "$path" rev-parse --git-dir >/dev/null 2>&1; then
    warn "$path 가 이미 있는데 git repo가 아니라 건너뜁니다"
    failed=1
    return
  fi

  if [ -n "$(git -C "$path" status --porcelain)" ]; then
    printf '%s: 건너뜀\n' "$path"
    warn "커밋 안 된 변경이 있어서 pull하지 않았습니다"
    return
  fi
  if ! git -C "$path" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    printf '%s: 건너뜀\n' "$path"
    warn "현재 브랜치($(git -C "$path" rev-parse --abbrev-ref HEAD))에 upstream이 없습니다"
    return
  fi

  local before after
  before=$(git -C "$path" rev-parse HEAD)
  if ! git -C "$path" pull --ff-only --quiet; then
    printf '%s: pull 실패\n' "$path"
    warn "fast-forward가 안 됩니다 (로컬 커밋이 upstream과 갈라짐) - 직접 정리하세요"
    failed=1
    return
  fi
  [ -f "$path/.gitmodules" ] && git -C "$path" submodule update --init --recursive --quiet
  after=$(git -C "$path" rev-parse HEAD)
  local ahead
  ahead=$(git -C "$path" rev-list --count '@{u}..HEAD')
  if [ "$before" = "$after" ]; then
    printf '%s: 최신\n' "$path"
    [ "$ahead" -gt 0 ] && warn "push 안 된 커밋 ${ahead}개"
  else
    printf '%s: %s커밋 받음 (%s..%s)\n' "$path" \
      "$(git -C "$path" rev-list --count "$before..$after")" \
      "$(git -C "$path" rev-parse --short "$before")" \
      "$(git -C "$path" rev-parse --short "$after")"
  fi
}

for entry in "${REPOS[@]}"; do
  read -r dir name <<<"$entry"
  if [ $# -gt 0 ]; then
    wanted=0
    for arg in "$@"; do [ "$arg" = "$name" ] && wanted=1; done
    [ $wanted = 1 ] || continue
  fi
  sync_repo "$dir" "$name"
done

# --- .env / extra-include.yml에 넣을 줄 안내 ---------------------------------

echo
env_lines=()
[ -d dev/router-docker-client ] && env_lines+=('ROUTER_CLIENT_SOURCE="./dev/router-docker-client/"')
[ -d dev/router-docker ] && env_lines+=('ROUTER_INCLUDE="./dev/router-docker/docker-compose.router.yml"')
[ -d dev/dind-authz-docker ] && env_lines+=('DIND_CONTEXT="./dev/dind-authz-docker"')
[ -d dev/code-server-autoinstall ] && env_lines+=('AUTOINSTALL_SOURCE="./dev/code-server-autoinstall"')
if [ ${#env_lines[@]} -gt 0 ]; then
  echo "# .env - 코어 의존물을 dev/ 로컬 체크아웃에서 빌드 (example-env 참고)."
  echo "# 고치는 것만 넣으세요 - 넣은 것은 태그 핀 대신 체크아웃의 현재 상태로 빌드됩니다."
  printf '%s\n' "${env_lines[@]}"
  echo
fi
if [ -d dev/envmigrate ]; then
  echo "# envmigrate는 Go 모듈이라 .env가 아니라 go.work로 바꿔 끼웁니다 (커밋하지 말 것):"
  echo "#   cd webmanager/backend && go work init . ../../dev/envmigrate"
  echo "#   cd dev/router-docker/backend && go work init . ../../envmigrate"
  echo "# 도커 빌드는 go.work를 안 쓰므로, 태그를 올리고 go get으로 bump해야 반영됩니다."
  echo
fi

includes=()
for manifest in builds/*/ootb-manifest.env; do
  [ -f "$manifest" ] || continue
  overlay=$(sed -n 's/^OOTB_COMPOSE_INCLUDE=["'\'']\{0,1\}\([^"'\'']*\)["'\'']\{0,1\}$/\1/p' "$manifest")
  if [ -z "$overlay" ]; then
    warn "$manifest 에 OOTB_COMPOSE_INCLUDE가 없어 include 줄을 만들지 못했습니다"
    continue
  fi
  includes+=("  - path: $(dirname "$manifest")/$overlay")
done
if [ ${#includes[@]} -gt 0 ]; then
  echo "# extra-include.yml - 붙이고 싶은 것만 남기세요 (.env에 EXTRA_INCLUDE=extra-include.yml)."
  echo "# provider마다 .env에 필요한 값이 있을 수 있습니다 - 각 repo의 ootb-manifest.env 참고."
  echo "include:"
  printf '%s\n' "${includes[@]}"
fi

exit $failed
