#!/bin/bash
# migrate-continue.sh - migrate.sh의 git pull 이후 나머지 전부. migrate.sh가
# `exec`로 이 파일을 새 프로세스로 띄웁니다 - 그 파일 헤더의 설명대로, git
# pull 직후부터는 반드시 새로 읽힌 파일에서 실행해야 방금 pull로 받은 수정이
# 바로 반영됩니다. 직접 실행하는 파일이 아닙니다.
#
# 인자: $1 TARGET_DIR, $2 OLD_HEAD(migrate.sh가 git pull 전에 기록해둔
# code-docker 자신의 커밋 - docker-compose.yml이 그 시점 이후로 바뀌었는지
# 비교하는 데 씀).

set -u

# shellcheck disable=SC1091
. "$(realpath "$(dirname "$0")")/ootb-lib.sh"

require_cmds git docker realpath awk

TARGET_DIR="$(realpath "$1")"
SCRIPT_DIR="$(realpath "$(dirname "$0")")"
OLD_HEAD="$2"
NEW_HEAD="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"

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
# EXTRA_INCLUDE로 실제 연동돼 있는 프로젝트만 매니페스트를 재적용하기 위해 미리
# 읽어둔다 - builds/ 아래에 클론만 해두고 아직 안 붙인 프로젝트까지 자동으로
# router allowlist에 넣어주면 곤란하다(경계 설정을 아무도 요구하지 않은 채
# 넓히는 셈).
extra_include_file="$(get_env_var "$TARGET_DIR/.env" EXTRA_INCLUDE)"
if [ -d "$TARGET_DIR/builds" ] && confirm "builds/ 아래 사이드 프로젝트들도 git pull할까요?" y; then
  for dir in "$TARGET_DIR"/builds/*/; do
    [ -d "$dir/.git" ] || continue
    [ "$(realpath "$dir")" = "$SCRIPT_DIR" ] && continue
    echo "  - $dir"
    if ! git -C "$dir" pull; then
      echo "    ! git pull 실패, 건너뜁니다."
      continue
    fi

    # 방금 pull로 매니페스트가 바뀌었을 수 있으므로 declarative 필드를 다시
    # 반영한다. 이게 없으면 매니페스트에 새 필드가 생길 때마다
    # "새로 까는 사람한테만 먹고 기존 배포엔 안 먹는" 상태가 되고, 실제로
    # OOTB_ROUTER_ALLOWED_TARGET_HOSTS가 그랬다 - 스택은 멀쩡히 뜨는데 router
    # 대상 등록만 조용히 거부됐다. 병합은 additive + 중복 제거라 매번 돌아도
    # 안전하고, 실제로 값이 바뀐 항목만 출력된다.
    name="$(basename "$dir")"
    [ -n "$extra_include_file" ] || continue
    grep -qF "builds/$name/" "$TARGET_DIR/$extra_include_file" 2>/dev/null || continue
    load_manifest "$dir" || continue
    apply_manifest_declarative "    " && echo "    (위 값은 $name 의 ootb-manifest.env가 선언한 것입니다)"
    # 사람에게 물어야 하는 OOTB_ENV_PROMPT_*도 같이 재적용한다 - 다만 **아직 그
    # 키가 env 파일에 아예 없을 때만** 묻는다(apply_manifest_prompts 주석 참고).
    # 예전에는 이게 최초 연동 때 한 번뿐이라, 이미 붙여둔 배포는 매니페스트에 새
    # 프롬프트가 생겨도(혹은 그때 Enter로 넘겼어도) 나중에 그 값을 설정할 경로가
    # 사실상 없었다 - roblox-studio-docker의 MCP_TOKEN이 실제로 그랬다.
    apply_manifest_prompts "    "
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
if confirm "설정값을 다시 검토할까요? (PREFIX/CODE_TZ/리소스 제한/ROUTER_HTTP_BIND 등)" n; then
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
