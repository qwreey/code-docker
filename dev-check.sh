#!/bin/bash
# dev-check.sh - 커밋/push 전에 돌리는 정적 검사. CI가 없는 대신 이것을 씁니다(혼자
# main에 바로 커밋하는 흐름이라 push 뒤에 도는 CI는 아무것도 막지 못합니다).
#
#   ./dev-check.sh                        # 이 체크아웃 + dev/* 전부, 작업 트리 그대로
#   ./dev-check.sh . dev/router-docker    # 골라서
#   ./dev-check.sh --clean                # 각 저장소의 HEAD를 임시 worktree에 꺼내서
#   ./dev-check.sh --clean=<rev> dev/router-docker
#
# 저장소마다:
#   - 추적 중인 go.mod가 있는 모듈마다 `gofmt -l`(목록이 나오면 실패)과 `go test ./...`
#   - 추적 중인 셸 스크립트(*.sh, 또는 sh/bash shebang) 전부 `bash -n`
#   - 이 체크아웃 자신이면 `docker compose config -q`
#
# --clean은 "커밋에 빠진 파일"을 잡기 위한 것입니다. 작업 트리에서는 커밋 안 한 새
# 파일 덕에 통과해도, push된 커밋만으로는 빌드가 안 되는 경우가 실제로 있었습니다
# (router의 Dockerfile이 Go 파일을 하나씩 COPY하는 것과 같은 부류). 이때 compose
# 검사는 .env 없이, 즉 배포가 받는 기본값(원격 태그 include)으로 돕니다.
#
# 여기 없는 것: webmanager/router 프론트엔드의 tsc(node_modules가 필요 - 이미지
# 빌드의 `tsc -b`가 검사합니다), builds/*(각자 독립 제품).
#
# dev-clone.sh가 이 체크아웃과 dev/*에 pre-push 훅으로 설치합니다(훅은 커밋할 수
# 없어서). 훅은 push하려는 커밋을 --clean=<그 커밋>으로 검사합니다.
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1

clean=0
rev=HEAD
repos=()
for arg in "$@"; do
  case $arg in
    --clean) clean=1 ;;
    --clean=*) clean=1; rev=${arg#--clean=} ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "알 수 없는 옵션: $arg" >&2; exit 2 ;;
    *) repos+=("${arg%/}") ;;
  esac
done
if [ ${#repos[@]} -eq 0 ]; then
  repos=(.)
  for d in dev/*/; do
    git -C "$d" rev-parse --git-dir >/dev/null 2>&1 && repos+=("${d%/}")
  done
fi

failed=0
fail() { printf '  ! %s\n' "$*"; failed=1; }

tmp=""
worktrees=()
cleanup() {
  for wt in "${worktrees[@]}"; do
    git -C "${wt%%|*}" worktree remove --force "${wt#*|}" >/dev/null 2>&1
  done
  [ -n "$tmp" ] && rm -rf "$tmp"
}
trap cleanup EXIT

# check_repo <표시 이름> <검사할 디렉터리>
check_repo() {
  local label=$1 dir=$2 mod f out
  echo "=== $label ==="

  while IFS= read -r mod; do
    mod=$(dirname "$mod")
    out=$(cd "$dir/$mod" && gofmt -l . 2>&1)
    if [ -n "$out" ]; then
      fail "gofmt -l ($mod):"
      printf '%s\n' "$out" | sed 's/^/      /'
    fi
    if out=$(cd "$dir/$mod" && go test ./... 2>&1); then
      echo "  - go test ($mod) 통과"
    else
      fail "go test ($mod) 실패:"
      printf '%s\n' "$out" | grep -v '^ok \|no test files' | sed 's/^/      /'
    fi
  done < <(git -C "$dir" ls-files -- 'go.mod' '*/go.mod')

  local scripts=()
  while IFS= read -r f; do
    [ -f "$dir/$f" ] || continue
    case $f in
      *.sh) scripts+=("$f") ;;
      *) head -n1 "$dir/$f" 2>/dev/null | grep -qE '^#!.*/(env )?(ba)?sh( |$)' && scripts+=("$f") ;;
    esac
  done < <(git -C "$dir" ls-files)
  local bad=0
  for f in "${scripts[@]}"; do
    if ! out=$(bash -n "$dir/$f" 2>&1); then
      fail "bash -n $f:"
      printf '%s\n' "$out" | sed 's/^/      /'
      bad=1
    fi
  done
  [ $bad = 0 ] && echo "  - bash -n 스크립트 ${#scripts[@]}개 통과"

  if [ "$label" = "." ]; then
    if out=$(cd "$dir" && docker compose config -q 2>&1); then
      echo "  - docker compose config 통과"
    else
      fail "docker compose config 실패:"
      printf '%s\n' "$out" | sed 's/^/      /'
    fi
  fi
}

for repo in "${repos[@]}"; do
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    echo "=== $repo ==="
    fail "git 저장소가 아닙니다"
    continue
  fi
  if [ $clean = 0 ]; then
    check_repo "$repo" "$repo"
    continue
  fi
  [ -n "$tmp" ] || tmp=$(mktemp -d)
  # 디렉터리 이름이 compose 프로젝트 이름이 되므로 "."을 그대로 쓰면 안 됩니다.
  name=${repo//\//_}
  [ "$name" = . ] && name=code-docker
  wt="$tmp/$name"
  if ! out=$(git -C "$repo" worktree add --detach "$wt" "$rev" 2>&1); then
    echo "=== $repo ==="
    fail "$rev 를 worktree로 꺼내지 못했습니다:"
    printf '%s\n' "$out" | sed 's/^/      /'
    continue
  fi
  worktrees+=("$repo|$wt")
  check_repo "$repo" "$wt"
done

echo
if [ $failed = 0 ]; then
  echo "전부 통과"
else
  echo "실패한 검사가 있습니다 (위 '!' 줄)"
fi
exit $failed
