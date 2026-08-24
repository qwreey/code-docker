#!/bin/bash
# migrate.sh - 이미 설치된 code-docker 배포를 최신 버전으로 올리는 스크립트.
# (처음 설치는 ootb.sh 참고 - 이 스크립트는 이미 .env/.env.webmanager/
# .env.router가 있는 기존 배포 전용입니다.)
#
# 사용법: builds/code-docker/migrate.sh (docker-compose.yml이 있는 배포
# 디렉터리를 확인/지정) 순서로: 1) code-docker(및 builds/ 아래 사이드
# 프로젝트) git pull, 2) docker-compose.yml이 예전에 커밋된 그대로면 최신으로
# 갱신(손댔으면 경고만), 3) docker compose build, 4) .env.webmanager/
# .env.router를 각각 webmanager/router-manager의 --env-migrate로 마이그레이션
# (빌드 직후 이미지로 `docker compose run --rm --entrypoint`만 실행 - 컨테이너를
# 실제로 띄우지 않음, ootb.sh의 --hash-password와 같은 기법. script/entrypoint.sh/
# router/script/netgate-entrypoint.sh 둘 다 CMD를 무시하고 항상 supervisord를
# 띄우므로 --entrypoint 우회가 필요합니다), 5) 원하면 ootb-config.sh를
# RECONFIGURE=1로/ootb-extra.sh를 다시 실행해 설정값 재검토/사이드 프로젝트
# 추가, 6) docker compose up -d.
#
# 최상위 .env는 마이그레이션 도구가 없으므로(example-env 자체 주석 참고) 건드리지
# 않습니다 - 새 키는 전부 합리적인 기본값이 있어 그대로 둬도 안전합니다.

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
  if ! git -C "$SCRIPT_DIR" pull origin master --recurse-submodules; then
    echo "  ! git pull 실패 - 지금 체크아웃된 상태로 계속 진행합니다."
  fi
fi
NEW_HEAD="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"
echo

if [ "$OLD_HEAD" != "$NEW_HEAD" ]; then
  echo "=== 2. docker-compose.yml 갱신 확인 ==="
  if diff -q <(git -C "$SCRIPT_DIR" show "$OLD_HEAD:docker-compose.yml") "$TARGET_DIR/docker-compose.yml" >/dev/null 2>&1; then
    cp "$SCRIPT_DIR/docker-compose.yml" "$TARGET_DIR/docker-compose.yml"
    echo "  - 손 안 댄 상태였어서 최신 docker-compose.yml로 갱신했습니다."
  else
    echo "  ! $TARGET_DIR/docker-compose.yml 이 예전 code-docker가 커밋했던 내용과 달라서"
    echo "    (직접 수정했거나 다른 도구가 건드린 것으로 보임) 자동으로 덮어쓰지 않았습니다."
    echo "    새 버전과의 차이는 아래와 같습니다 - 필요하면 직접 병합하세요:"
    diff -u "$TARGET_DIR/docker-compose.yml" "$SCRIPT_DIR/docker-compose.yml" || true
  fi
  cp "$SCRIPT_DIR/empty-extra-include.yml" "$TARGET_DIR/empty-extra-include.yml"
  echo
fi

echo "=== 3. 사이드 프로젝트 업데이트 ==="
if [ -d "$TARGET_DIR/builds" ] && confirm "builds/ 아래 사이드 프로젝트들도 git pull할까요?" y; then
  for dir in "$TARGET_DIR"/builds/*/; do
    [ -d "$dir/.git" ] || continue
    [ "$(realpath "$dir")" = "$SCRIPT_DIR" ] && continue
    echo "  - $dir"
    if ! git -C "$dir" pull; then
      echo "    ! git pull 실패, 건너뜁니다."
    fi
  done
fi
echo

cd "$TARGET_DIR" || exit 1

built=0
if confirm "지금 docker compose build를 수행할까요?" y; then
  if docker compose build; then
    built=1
  else
    echo "  ! docker compose build 실패 - 이후 env 마이그레이션 단계는 건너뜁니다."
  fi
fi
echo

if [ "$built" = "1" ]; then
  echo "=== 4. env 마이그레이션 ==="
  echo "빌드 직후 이미지로 --env-migrate만 실행합니다(컨테이너를 실제로 띄우지"
  echo "않음, ootb.sh의 --hash-password와 동일한 --entrypoint 우회 기법)."

  MIGRATE_TARGETS=(
    ".env.webmanager:code-docker:/etc/code-docker/webmanager/webmanager"
    ".env.router:code-docker-router:/usr/local/bin/router-manager"
  )
  for entry in "${MIGRATE_TARGETS[@]}"; do
    file="${entry%%:*}"
    rest="${entry#*:}"
    service="${rest%%:*}"
    bin="${rest#*:}"

    [ -f "$TARGET_DIR/$file" ] || continue
    if confirm "$file 을 최신 스키마로 마이그레이션할까요?" y; then
      cat "$TARGET_DIR/$file" >> "$TARGET_DIR/$file.bak"
      new="$(docker compose run --rm -T --entrypoint "$bin" "$service" --env-migrate < "$TARGET_DIR/$file")"
      if [ -n "$new" ]; then
        printf '%s' "$new" > "$TARGET_DIR/$file"
        echo "  - $file 마이그레이션 완료 (백업: $file.bak)"
      else
        echo "  ! $file 마이그레이션 실패 - 기존 파일 그대로 둡니다."
      fi
    fi
  done
  echo
fi

echo "=== 5. 설정 재검토 ==="
if confirm "설정값을 다시 검토할까요? (PREFIX/TZ/리소스 제한/ROUTER_HTTP_BIND 등)" n; then
  RECONFIGURE=1 bash "$SCRIPT_DIR/ootb-config.sh" "$TARGET_DIR"
fi
if confirm "새 사이드 프로젝트를 추가할까요? (기존에 연동된 것들은 위 3단계에서 이미 git pull됨)" n; then
  bash "$SCRIPT_DIR/ootb-extra.sh" "$TARGET_DIR"
fi
echo

if confirm "지금 docker compose up -d를 수행할까요?" y; then
  docker compose up -d
else
  echo "나중에 아래 명령으로 직접 띄우세요:"
  echo "  cd $TARGET_DIR && docker compose up -d"
fi

echo
echo "=== 완료 ==="
