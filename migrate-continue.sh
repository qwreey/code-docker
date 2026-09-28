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

# router/code-dind/code-server-autoinstall/envmigrate는 submodule이었다가 태그로
# 핀한 원격 참조로 바뀌었습니다(CLAUDE.md "Development checkout layout"). git pull은
# submodule을 추적에서 빼기만 하고 그 체크아웃 디렉터리는 untracked로 남겨두므로
# (실측), 여기서 정리합니다. 빌드에는 이미 안 쓰이고(.dockerignore에도 있음) 남아
# 있으면 "아직 저걸 쓰나?" 하는 혼란만 남습니다. 단, 그 안에 커밋 안 된 변경이나
# 어느 원격에도 없는 커밋이 있으면 지우지 않습니다 - 실제로 router의 핀이 push된 적
# 없는 로컬 커밋이었던 적이 있습니다.
leftover=()
for name in router code-dind code-server-autoinstall envmigrate; do
  dir="$SCRIPT_DIR/$name"
  [ -e "$dir" ] || continue
  git -C "$SCRIPT_DIR" ls-files --error-unmatch "$name" >/dev/null 2>&1 && continue
  if [ ! -f "$dir/.git" ]; then
    echo "  ! $dir 는 옛 submodule 체크아웃으로 보이지 않아(.git 파일 없음) 그대로 둡니다."
    continue
  fi
  if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    echo "  ! $dir 에 커밋 안 된 변경이 있어 지우지 않았습니다 - 확인 후 직접 지우세요."
    continue
  fi
  unpushed="$(git -C "$dir" log --oneline --branches --not --remotes 2>/dev/null)"
  if [ -n "$unpushed" ]; then
    echo "  ! $dir 에 어느 원격에도 없는 커밋이 있어 지우지 않았습니다:"
    printf '%s\n' "$unpushed" | sed 's/^/      /'
    echo "    해당 저장소에 push한 뒤 다시 실행하거나, 필요 없으면 직접 지우세요."
    continue
  fi
  leftover+=("$name")
done
if [ ${#leftover[@]} -gt 0 ]; then
  echo "=== 1-1. 옛 submodule 체크아웃 정리 ==="
  echo "더 이상 쓰지 않는 디렉터리: ${leftover[*]} (변경/미push 커밋 없음 확인)"
  if confirm "지울까요?" y; then
    for name in "${leftover[@]}"; do
      rm -rf "${SCRIPT_DIR:?}/$name" "${SCRIPT_DIR:?}/.git/modules/$name"
      echo "  - 삭제: $name"
    done
  else
    echo "  - 그대로 둡니다 (빌드에는 영향 없음)."
  fi
  echo
fi

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
    # 아래 건너뛰기 조건들은 원래 전부 조용히 continue했다 - 그래서 매니페스트가
    # 재적용되지 않아도 화면에는 git pull 결과만 보이고, 사용자 입장에서는 "돌렸는데
    # 아무 일도 안 일어났다"가 된다(실제로 MCP_TOKEN이 안 생기는 걸 그렇게 발견했다).
    # 건너뛴 이유는 반드시 말한다.
    name="$(basename "$dir")"
    if [ -z "$extra_include_file" ]; then
      echo "    (.env에 EXTRA_INCLUDE가 없어 매니페스트 재적용을 건너뜁니다)"
      continue
    fi
    if ! grep -qF "builds/$name/" "$TARGET_DIR/$extra_include_file" 2>/dev/null; then
      echo "    ($extra_include_file 에 builds/$name/ 항목이 없어 매니페스트 재적용을 건너뜁니다"
      echo "     - 클론만 해두고 아직 연동하지 않은 프로젝트로 봅니다)"
      continue
    fi
    if ! load_manifest "$dir"; then
      echo "    (ootb-manifest.env가 없어 매니페스트 재적용을 건너뜁니다)"
      continue
    fi
    if apply_manifest_declarative "    "; then
      echo "    (위 값은 $name 의 ootb-manifest.env가 선언한 것입니다)"
    else
      echo "    매니페스트 재적용: 이미 최신이라 바뀐 값 없음"
    fi
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

# 이 build가 방금 pull한 것을 실제 컨테이너에 반영하는 유일한 단계입니다. `up -d`는
# 이미 있는 이미지를 다시 빌드하지 않으므로, 건너뛰면 새 코드는 디스크에만 있고
# 컨테이너는 옛 이미지 그대로 다시 뜹니다. EXTRA_INCLUDE로 붙은 builds/ 프로젝트도
# 같은 compose 프로젝트의 서비스라 이 한 번으로 같이 빌드됩니다.
built=0
if confirm "지금 docker compose build를 수행할까요? (code-docker와 연동된 사이드 프로젝트 전부)" y; then
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

  # router-manager 비밀번호는 RECONFIGURE(5단계의 ootb-config.sh)가 다룰 수
  # 없습니다 - 그 스크립트는 docker를 전혀 안 쓰는 순수 env 편집기인데, 이
  # 값은 방금 빌드한 이미지로 --hash-password를 돌려야 만들어집니다. 그래서
  # "빌드 직후"인 여기서 묻습니다. 이미 설정돼 있으면 함수가 그렇다고 말하고
  # 넘어가므로 매번 돌려도 시끄럽지 않습니다.
  #
  # 기존 배포에 이 질문이 생긴 이유: 비밀번호 미설정 상태의 router-manager
  # 관리 API는 이제 통과가 아니라 503입니다(fail-closed) - 즉 예전처럼
  # "안 잠긴 채 동작"하는 게 아니라 아예 동작하지 않습니다.
  echo "=== 4-1. router-manager 관리자 비밀번호 ==="
  prompt_router_manager_password "$TARGET_DIR"
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

if [ "$built" != "1" ]; then
  echo "  ! 이번에 이미지를 빌드하지 않았습니다 - up -d는 기존 이미지로 뜨므로 방금 받은"
  echo "    업데이트는 반영되지 않습니다. 나중에 docker compose build 후 up -d 하세요."
fi
if confirm "지금 docker compose up -d를 수행할까요?" y; then
  docker compose up -d
else
  echo "나중에 아래 명령으로 직접 띄우세요:"
  echo "  cd $TARGET_DIR && docker compose up -d"
fi

echo
echo "=== 완료 ==="
