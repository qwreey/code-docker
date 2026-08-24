#!/bin/bash
# ootb-lib.sh - ootb.sh와 migrate.sh가 공유하는 헬퍼 함수 모음. 직접 실행하는
# 게 아니라 항상 `. "$(dirname "$0")/ootb-lib.sh"`로 source해서 씁니다 - 함수
# 안의 "$0"은 (source는 $0을 안 바꾸므로) 이 파일이 아니라 source한 쪽
# 스크립트(ootb.sh/migrate.sh) 자신의 경로를 그대로 가리킵니다.

require_cmds() {
  # require_cmds cmd1 cmd2 ...
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "$(basename "$0"): '$cmd' 명령을 찾을 수 없습니다. 설치 후 다시 실행하세요." >&2
      exit 1
    fi
  done
}

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

locate_target_dir() {
  # SCRIPT_DIR/DEFAULT_TARGET_DIR/TARGET_DIR 전역 변수를 설정.
  SCRIPT_DIR="$(realpath "$(dirname "$0")")"
  if [ ! -f "$SCRIPT_DIR/docker-compose.yml" ]; then
    echo "$(basename "$0"): $SCRIPT_DIR 에서 docker-compose.yml을 찾을 수 없습니다 - code-docker 레포 안에서 실행 중인지 확인하세요." >&2
    exit 1
  fi
  DEFAULT_TARGET_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

  echo "설치 대상 디렉터리(기본값): $DEFAULT_TARGET_DIR"
  printf "다른 경로를 쓰려면 입력하세요 (Enter면 위 기본값 사용): "
  read -r custom_target
  if [ -n "$custom_target" ]; then
    TARGET_DIR="$(realpath -m "$custom_target")"
  else
    TARGET_DIR="$DEFAULT_TARGET_DIR"
  fi
  mkdir -p "$TARGET_DIR"
  echo "-> $TARGET_DIR"
  echo
}
