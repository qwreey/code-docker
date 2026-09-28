#!/bin/bash
# dev-bump-router-client.sh - router-docker-client의 새 태그를 모든 소비처의 핀에 한
# 번에 반영합니다.
#
#   ./dev-bump-router-client.sh v0.1.1            # 파일만 고침
#   ./dev-bump-router-client.sh --commit v0.1.1   # 저장소마다 커밋까지 (push는 안 함)
#
# 소비처는 이 체크아웃 자신과 dev/*, builds/* 아래의 git 저장소 중, 추적 중인
# Dockerfile*/docker-compose*.yml에 `ROUTER_CLIENT_REF=<태그>`(Dockerfile ARG) 또는
# `${ROUTER_CLIENT_REF:-<태그>}`(compose) 핀이 있는 곳입니다 - 목록을 따로 두지 않고
# 찾아내므로, 새 소비처도 같은 변수 이름으로 핀하면 자동으로 따라옵니다.
# router-docker-client 자신(netinit/Dockerfile)은 제외합니다: 그 핀은 태그를 찍는
# 커밋 안에서 맞춰야 하기 때문입니다(그 저장소의 CLAUDE.md 참고).
#
# 태그가 GitHub에 없으면 아무것도 고치지 않습니다 - 없는 태그를 가리키면 그 소비처의
# 다음 빌드가 통째로 실패합니다.
set -u

cd "$(dirname "$0")" || exit 1

REPO_URL="https://github.com/qwreey/router-docker-client.git"
# 핀이 있어야 하는데 체크아웃이 없으면 알려줄 소비처들 (dev-clone.sh의 이름과 같음).
EXPECTED=(
  "dev/dind-authz-docker"
  "builds/code-docker-chrome"
  "builds/roblox-studio-docker"
  "builds/code-docker-firecrawl"
)

commit=0
if [ "${1:-}" = "--commit" ]; then
  commit=1
  shift
fi
tag="${1:-}"
if ! printf '%s' "$tag" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "사용법: $0 [--commit] vX.Y.Z" >&2
  exit 2
fi

if ! git ls-remote --exit-code --tags "$REPO_URL" "refs/tags/$tag" >/dev/null; then
  echo "! $tag 태그가 $REPO_URL 에 없습니다 - 먼저 push하세요. 아무것도 고치지 않았습니다." >&2
  exit 1
fi

# 핀을 찾고 고치는 대상 파일 (git pathspec - `*`는 하위 디렉터리까지 맞음).
PINNED_FILES=('*Dockerfile*' '*docker-compose*.yml')

failed=0
warn() { printf '  ! %s\n' "$*"; }

for path in "${EXPECTED[@]}"; do
  [ -d "$path/.git" ] || warn "$path 체크아웃이 없어 건너뜁니다 - ./dev-clone.sh $(basename "$path") 후 다시 실행하세요."
done

for repo in . dev/* builds/*; do
  [ -d "$repo/.git" ] || continue
  [ "$repo" = "dev/router-docker-client" ] && continue

  # 핀이 아닌, 아직 떠 있는 참조는 이 스크립트가 옮겨줄 수 없으니 보이게 알린다.
  floating="$(git -C "$repo" grep -nE 'router-docker-client\.git#(main|master)[:"[:space:]]' -- "${PINNED_FILES[@]}" 2>/dev/null)"
  if [ -n "$floating" ]; then
    warn "$repo 에 태그로 고정되지 않은 참조가 있습니다 (직접 ROUTER_CLIENT_REF로 바꾸세요):"
    printf '%s\n' "$floating" | sed 's/^/      /'
    failed=1
  fi

  mapfile -t files < <(git -C "$repo" grep -lE 'ROUTER_CLIENT_REF(=|:-)' -- "${PINNED_FILES[@]}" 2>/dev/null)
  [ ${#files[@]} -gt 0 ] || continue

  dirty="$(git -C "$repo" status --porcelain -- "${files[@]}")"
  before="$(cd "$repo" && cat -- "${files[@]}" | md5sum)"
  for f in "${files[@]}"; do
    sed -i -E "s/(ROUTER_CLIENT_REF(=|:-))[^}\"[:space:]]+/\\1$tag/g" "$repo/$f"
  done

  if [ "$before" = "$(cd "$repo" && cat -- "${files[@]}" | md5sum)" ]; then
    printf '%s: 이미 %s\n' "$repo" "$tag"
    continue
  fi
  printf '%s: %s 로 변경 (%s)\n' "$repo" "$tag" "${files[*]}"

  [ "$commit" = 1 ] || continue
  if [ -n "$dirty" ]; then
    warn "$repo: 이 파일들에 원래 커밋 안 된 변경이 있어서 커밋하지 않았습니다 - 확인 후 직접 커밋하세요."
    failed=1
    continue
  fi
  if ! git -C "$repo" commit -q -m "Bump router-docker-client to $tag" -- "${files[@]}"; then
    warn "$repo: 커밋 실패"
    failed=1
  fi
done

cat <<EOF

다음 단계:
  - 바뀐 저장소를 각각 push하세요 (이 스크립트는 push하지 않습니다).
  - dev/dind-authz-docker의 핀은 그 저장소를 단독으로 빌드할 때만 쓰입니다 - code-docker는
    netshare를 자기 ROUTER_CLIENT_REF로 덮어씁니다. 새 dind 태그와 DIND_REF bump는 다음에
    dind를 릴리스할 때 같이 해도 됩니다.
EOF
exit "$failed"
