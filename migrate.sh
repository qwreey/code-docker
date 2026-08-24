#!/bin/bash
# migrate.sh - 이미 설치된 code-docker 배포를 최신 버전으로 올리는 스크립트의
# 진입점. (처음 설치는 ootb.sh 참고 - 이 스크립트는 이미 .env/.env.webmanager/
# .env.router가 있는 기존 배포 전용입니다.)
#
# 이 파일은 git pull까지만 하고 나머지는 전부 migrate-continue.sh에 넘깁니다 -
# bash는 실행 중인 스크립트 파일을 처음부터 끝까지 미리 메모리에 다 읽어두는 게
# 아니라 필요할 때(오프셋 기준으로) 디스크에서 계속 읽어들이므로, git pull이 이
# 파일 자체를 갈아치운 뒤에도 "지금 이 프로세스"가 그 뒤에 실행하는 코드는 여전히
# pull 전의(구버전) 내용일 수 있습니다 - 방금 pull로 받은 migrate.sh 자신의
# 버그 수정/새 기능이 정작 이번 실행에는 반영되지 않는 것. `exec`로 완전히 새
# 프로세스(migrate-continue.sh)를 띄우면 그 파일은 그 시점에 디스크에서 새로
# 읽히므로 이 문제가 없습니다.
#
# 전체 흐름(자세한 설명은 migrate-continue.sh 헤더 참고): 1) code-docker git
# pull, 2) docker-compose.yml이 예전에 커밋된 그대로면 최신으로 갱신(손댔으면
# 경고만), 3) builds/ 아래 사이드 프로젝트 git pull, 4) docker compose build,
# 5) .env.webmanager/.env.router env-migrate, 6) 원하면 설정 재검토/사이드
# 프로젝트 추가, 7) docker compose up -d.

set -u

# shellcheck disable=SC1091
. "$(realpath "$(dirname "$0")")/ootb-lib.sh"

require_cmds git docker realpath

echo "=== code-docker 마이그레이션 ==="
locate_target_dir

if [ ! -f "$TARGET_DIR/docker-compose.yml" ]; then
  echo "migrate.sh: $TARGET_DIR 에 docker-compose.yml이 없습니다 - 처음 설치라면 ootb.sh를 쓰세요." >&2
  exit 1
fi

echo "=== 1. code-docker 자신 업데이트 ==="
OLD_HEAD="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"
if confirm "code-docker($SCRIPT_DIR)를 git pull로 최신화할까요?" y; then
  if ! git -C "$SCRIPT_DIR" pull origin main --recurse-submodules; then
    echo "  ! git pull 실패 - 지금 체크아웃된 상태로 계속 진행합니다."
  fi
fi
echo

exec bash "$SCRIPT_DIR/migrate-continue.sh" "$TARGET_DIR" "$OLD_HEAD"
