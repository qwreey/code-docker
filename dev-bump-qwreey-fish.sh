#!/bin/bash
# dev-bump-qwreey-fish.sh - config/user-init/user-init.default.sh가 고정한
# qwreey-fish(QWREEY_FISH_QS_SETUP_SHA/_SHA256)를 새 커밋으로 옮깁니다. 바꾸기 전에
# 지금 핀에서 새 커밋까지의 diff를 보여줍니다.
#
#   ./dev-bump-qwreey-fish.sh                    # qwreey-fish main의 최신 커밋으로
#   ./dev-bump-qwreey-fish.sh <commit>           # 특정 커밋으로
#   ./dev-bump-qwreey-fish.sh --commit [<commit>]  # 검토 후 이 저장소에 커밋까지 (push는 안 함)
#
# diff는 저장소 전체입니다 - qs_setup.fish만이 아니라, --self로 그 커밋의
# qwreey-fish가 통째로 플러그인으로 깔리기 때문입니다. qs_setup.fish 안의 고정값
# 블록(fisher/플러그인/mise/도구)이 바뀌었다면 그 upstream 검토는 qwreey-fish의
# scripts/bump-pins.sh에서 이미 한 것입니다.
#
# sha256은 컨테이너가 실제로 받는 곳(raw.githubusercontent.com의 그 커밋)에서
# 계산합니다 - 그래서 새 커밋은 GitHub에 push돼 있어야 합니다.
set -u

cd "$(dirname "$0")" || exit 1

REPO=qwreey/qwreey-fish
TARGET=config/user-init/user-init.default.sh

commit=0
if [ "${1:-}" = "--commit" ]; then
  commit=1
  shift
fi

old=$(sed -n 's/^QWREEY_FISH_QS_SETUP_SHA="\([0-9a-f]*\)"$/\1/p' "$TARGET")
if [ -z "$old" ]; then
  echo "! $TARGET 에서 QWREEY_FISH_QS_SETUP_SHA를 찾지 못했습니다" >&2
  exit 1
fi

new="${1:-}"
if [ -z "$new" ]; then
  new=$(git ls-remote "https://github.com/$REPO.git" refs/heads/main | cut -f1)
fi
if ! printf '%s' "$new" | grep -qE '^[0-9a-f]{40}$'; then
  echo "사용법: $0 [--commit] [<40자리 커밋 SHA>]" >&2
  exit 2
fi
if [ "$new" = "$old" ]; then
  echo "이미 ${new:0:12} 입니다."
  exit 0
fi

# diff를 볼 저장소: dev-clone.sh로 받은 dev/qwreey-fish가 있으면 그걸, 없으면 임시 클론.
if [ -d dev/qwreey-fish/.git ]; then
  src=dev/qwreey-fish
  git -C "$src" fetch --quiet origin || { echo "! dev/qwreey-fish fetch 실패" >&2; exit 1; }
else
  src=$(mktemp -d)
  trap 'rm -rf "$src"' EXIT
  git clone --quiet --bare --filter=blob:none "https://github.com/$REPO.git" "$src" || exit 1
fi
if ! git -C "$src" cat-file -e "$new^{commit}" 2>/dev/null; then
  echo "! ${new:0:12} 커밋이 $REPO 에 없습니다 - 먼저 push하세요. 아무것도 고치지 않았습니다." >&2
  exit 1
fi

url="https://raw.githubusercontent.com/$REPO/$new/functions/qs_setup.fish"
if ! sha256=$(curl -fsSL "$url" | sha256sum | cut -d' ' -f1) || [ -z "$sha256" ]; then
  echo "! $url 를 받지 못했습니다" >&2
  exit 1
fi

echo "qwreey-fish ${old:0:12} -> ${new:0:12}"
if ! git -C "$src" merge-base --is-ancestor "$old" "$new" 2>/dev/null; then
  echo "  ! 지금 핀이 새 커밋의 조상이 아닙니다(히스토리가 바뀜) - diff만 믿지 말고 전체를 보세요."
fi
git -C "$src" --no-pager log --format='  %h %ad %s' --date=short "$old..$new"
git -C "$src" --no-pager diff --stat "$old" "$new"
echo
read -r -p "전체 diff를 볼까요? [Y/n] " a
case $a in [nN]*) ;; *) git -C "$src" diff "$old" "$new" ;; esac
read -r -p "이 커밋으로 옮길까요? [y/N] " a
case $a in [yY]*) ;; *) echo "그대로 둡니다."; exit 0 ;; esac

sed -i \
  -e "s/^QWREEY_FISH_QS_SETUP_SHA=\"[0-9a-f]*\"$/QWREEY_FISH_QS_SETUP_SHA=\"$new\"/" \
  -e "s/^QWREEY_FISH_QS_SETUP_SHA256=\"[0-9a-f]*\"$/QWREEY_FISH_QS_SETUP_SHA256=\"$sha256\"/" \
  "$TARGET"
git --no-pager diff -- "$TARGET"

echo
echo "이미 돌고 있는 /code 볼륨에는 적용되지 않습니다(qs_setup은 새 볼륨에서 한 번만) -"
echo "기존 볼륨은 컨테이너 안에서 qs_update로 올립니다."
if [ $commit = 1 ]; then
  git add "$TARGET"
  git commit -q -m "Bump qwreey-fish to ${new:0:12}" && git log --oneline -1
fi
