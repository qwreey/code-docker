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

resolve_target_dir() {
  # resolve_target_dir [target_dir] - $1이 있으면(ootb.sh/migrate.sh가 이미
  # 확인해서 서브스크립트로 넘겨주는 경우) 그걸 그대로 SCRIPT_DIR/TARGET_DIR로
  # 쓰고, 없으면(단독 실행) locate_target_dir로 대화형 확인.
  if [ -n "${1:-}" ]; then
    SCRIPT_DIR="$(realpath "$(dirname "$0")")"
    TARGET_DIR="$(realpath "$1")"
  else
    locate_target_dir
  fi
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

# --- 사이드 프로젝트 매니페스트(ootb-manifest.env) --------------------------
# 매니페스트를 읽어 code-docker 쪽 env에 반영하는 로직은 두 곳에서 씁니다:
# ootb-extra.sh(처음 연동할 때)와 migrate-continue.sh(이미 연동된 프로젝트를
# git pull한 뒤 재적용할 때). 한쪽에만 두면 매니페스트에 declarative 필드가
# 새로 생길 때마다 "새로 까는 사람한테는 먹는데 기존 배포엔 안 먹는" 격차가
# 그대로 반복됩니다 - OOTB_ROUTER_ALLOWED_TARGET_HOSTS가 실제로 그랬습니다
# (스택은 멀쩡히 뜨는데 router 대상 등록만 조용히 거부되는 증상).
# 스키마 전체는 docs/tips/ootb-manifest.md 참고.

load_manifest() {
  # load_manifest <clone_dir> - 매니페스트를 source해서 OOTB_* 변수를 채웁니다.
  # 여러 프로젝트를 연속으로 처리할 때 앞 프로젝트의 값이 새지 않도록 먼저
  # 전부 unset합니다. 매니페스트가 없으면 1, 필수 필드가 없으면 (사유를
  # 출력하고) 2를 반환합니다 - "없음"과 "잘못됨"은 호출부가 다르게 안내해야
  # 해서 구분합니다.
  _lm_dir="${1%/}"
  _lm_manifest="$_lm_dir/ootb-manifest.env"

  unset OOTB_NAME OOTB_DESCRIPTION OOTB_COMPOSE_INCLUDE OOTB_EXTRA_INTERNAL_NETWORKS
  unset OOTB_ROUTER_ALLOWED_TARGET_HOSTS OOTB_ENV_TARGET
  for _lm_v in $(compgen -v OOTB_ENV_PROMPT_ 2>/dev/null); do unset "$_lm_v"; done

  [ -f "$_lm_manifest" ] || return 1

  # PREFIX를 미리 환경에 내보내는 이유: 매니페스트가 OOTB_EXTRA_INTERNAL_NETWORKS
  # 같은 값 안에 "${PREFIX}"를 그대로 써서(예: roblox-studio-docker) 자기 사이드
  # 네트워크 이름을 code-docker 쪽 PREFIX와 맞출 수 있게 하기 위함 - source 시점에
  # 일반 쉘 변수 치환으로 풀린다. PREFIX가 아직 .env에 없으면 빈 문자열로 취급된다.
  PREFIX="$(get_env_var "$TARGET_DIR/.env" PREFIX)"
  export PREFIX
  # 매니페스트는 그냥 source된다 - 즉 그 레포가 준 쉘 코드를 그대로 실행한다.
  # 이 스크립트들은 어차피 같은 레포를 git clone/pull하고 그 Dockerfile을
  # docker compose build까지 하므로 신뢰 수준이 같다(docs/tips/ootb-manifest.md의
  # "참고" 절). 사용자가 그 URL을 직접 입력해 붙이기로 한 것이 전제.
  # shellcheck disable=SC1090
  . "$_lm_manifest"

  if [ -z "${OOTB_COMPOSE_INCLUDE:-}" ]; then
    echo "  ! $(basename "$_lm_dir")/ootb-manifest.env에 OOTB_COMPOSE_INCLUDE가 없습니다." >&2
    return 2
  fi
  return 0
}

apply_manifest_declarative() {
  # apply_manifest_declarative [들여쓰기] - load_manifest로 읽어둔 매니페스트 중
  # "사용자에게 묻지 않고 프로젝트가 값을 직접 선언하는" 필드들만 code-docker 쪽
  # env 파일에 병합합니다 (OOTB_ENV_PROMPT_*처럼 사람에게 물어야 하는 건 여기
  # 없음 - 그래서 migrate처럼 비대화형에 가까운 흐름에서도 그대로 부를 수 있다).
  # 전부 additive 병합 + 중복 제거라 몇 번을 돌려도 결과가 같고, 실제로 값이
  # 바뀐 항목만 출력합니다. 바뀐 게 하나라도 있으면 0, 없으면 1을 반환합니다.
  _amd_indent="${1:-    }"
  _amd_changed=0

  # DEPRECATED 경로. 이제 이런 네트워크는 자기 오버레이 파일에서 직접
  # `netinit.exempt-forward: "true"` 라벨을 달면 되고, 그러면 code-docker의 .env를
  # 고칠 일 자체가 없다 - 붙는 쪽이 자기 요구를 스스로 기술하는 게 애초에 EXTRA_INCLUDE의
  # 취지였다(자세한 건 example-env의 해당 항목과 .claude/archive/netinit-docker-plan-done.md).
  # 아직 라벨로 옮기지 않은 매니페스트를 위해 한 주기 동안 남겨둔다 - netinit-docker가
  # 이 env를 읽으면 경고를 남긴다.
  if [ -n "${OOTB_EXTRA_INTERNAL_NETWORKS:-}" ]; then
    _amd_cur="$(get_env_var "$TARGET_DIR/.env" NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS)"
    _amd_new="$(printf '%s %s' "$_amd_cur" "$OOTB_EXTRA_INTERNAL_NETWORKS" | xargs)"
    if [ "$_amd_new" != "$_amd_cur" ]; then
      set_env_var "$TARGET_DIR/.env" NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS "\"$_amd_new\""
      echo "${_amd_indent}- NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS=$_amd_new (DEPRECATED - 오버레이 라벨로 옮기는 걸 권장)"
      _amd_changed=1
    fi
  fi

  # router의 Dev Proxy/App Routes(VNC 탭 포함) 대상 호스트 allowlist. 기본값은
  # code-docker/dind 둘뿐이라, 사이드 프로젝트가 자기 컨테이너를 대상으로 쓰려면
  # 여기 등록돼야 한다 - 안 하면 컨테이너는 멀쩡히 뜨는데 대상 등록만 거부돼서
  # ("target host ...가 allowlist에 없음") ootb로 깔고도 .env.router를 손으로 열게 된다.
  #
  # OOTB_ENV_PROMPT_*로 물어보지 않고 매니페스트가 값을 직접 선언하는 이유:
  # 사용자는 어떤 호스트네임이 필요한지 알 도리가 없고 붙는 프로젝트만 안다.
  # OOTB_EXTRA_INTERNAL_NETWORKS와 같은 declarative merge지만, 그쪽과 달리 Docker
  # 라벨로 옮길 수 없다 - router-manager는 (자기가 보안 경계라서) docker.sock을
  # 의도적으로 안 갖고 있어서 라벨을 읽을 수단이 없다. 자세한 건 docs/tips/ootb-manifest.md.
  #
  # 매니페스트는 공백/콤마 아무거나 써도 되고, 여기서 ROUTER_EXTRA_ALLOWED_TARGET_HOSTS가
  # 파싱하는 콤마 구분으로 정규화하면서 기존 값과 합치고 중복을 제거한다.
  if [ -n "${OOTB_ROUTER_ALLOWED_TARGET_HOSTS:-}" ]; then
    _amd_cur="$(get_env_var "$TARGET_DIR/.env.router" ROUTER_EXTRA_ALLOWED_TARGET_HOSTS)"
    _amd_new="$(printf '%s,%s' "$_amd_cur" "$OOTB_ROUTER_ALLOWED_TARGET_HOSTS" | awk '
      {
        n = split($0, a, /[, \t]+/)
        for (i = 1; i <= n; i++)
          if (a[i] != "" && !seen[a[i]]++) out = (out == "" ? a[i] : out "," a[i])
        print out
      }')"
    if [ "$_amd_new" != "$_amd_cur" ]; then
      set_env_var "$TARGET_DIR/.env.router" ROUTER_EXTRA_ALLOWED_TARGET_HOSTS "\"$_amd_new\""
      echo "${_amd_indent}- ROUTER_EXTRA_ALLOWED_TARGET_HOSTS=$_amd_new (router 대상 allowlist)"
      _amd_changed=1
    fi
  fi

  [ "$_amd_changed" = "1" ]
}

has_env_var() {
  # has_env_var <file> <key> - 주석 처리되지 않은 `key=` 라인이 있으면 0.
  # get_env_var와 달리 **값이 비어있어도 "있다"로 칩니다** - 아래
  # apply_manifest_prompts가 "물어봤는데 사용자가 껐다"와 "아직 안 물어봤다"를
  # 구분하는 데 씁니다(빈 값 = 그 기능 끔, 이 코드베이스 전반의 관례).
  grep -qE "^$2=" "$1" 2>/dev/null
}

gen_secret() {
  # 32바이트 랜덤을 hex 64자로. openssl이 없는 최소 환경을 위한 폴백 포함.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64
    echo
  fi
}

apply_manifest_prompts() {
  # apply_manifest_prompts [들여쓰기] - load_manifest로 읽어둔 매니페스트의
  # OOTB_ENV_PROMPT_*를 순서대로 물어 $OOTB_ENV_TARGET(기본 .env)에 씁니다.
  # apply_manifest_declarative의 짝 - 그쪽이 "프로젝트가 값을 직접 선언하는"
  # 필드라면 이쪽은 "사람이 답해야 하는" 필드고, 둘 다 ootb-extra.sh(최초 연동)와
  # migrate-continue.sh(이미 연동된 배포)에서 같이 호출됩니다.
  #
  # **이미 그 키가 env 파일에 있으면(빈 값이어도) 묻지 않고 건너뜁니다.** 이게
  # 이 함수를 migrate 쪽에서도 부를 수 있게 하는 전부입니다 - 최초 연동 때만
  # 물어보던 예전 구조에서는, 이미 붙여둔 배포에 새 프롬프트가 생겨도(혹은 그때
  # 그냥 Enter로 넘겼어도) 나중에 그 값을 설정할 경로가 사실상 없었습니다
  # (같은 git URL을 ootb-extra.sh에 다시 입력하는 비공식 우회밖에 없었음).
  # declarative 필드가 정확히 같은 이유로 재적용되게 바뀐 것과 같은 격차입니다
  # - docs/tips/ootb-manifest.md 참고.
  #
  # 사용자가 빈 값/거절로 답한 것도 그 키를 빈 값으로 기록해서 남깁니다 - 안
  # 그러면 매번 migrate를 돌릴 때마다 같은 질문을 다시 받게 됩니다. 나중에
  # 마음이 바뀌면 env 파일의 그 줄을 직접 채우면 됩니다(이미 설정된 값을 바꾸는
  # 방법도 동일합니다 - 이 함수는 기존 값을 절대 덮어쓰지 않습니다).
  _amp_indent="${1:-    }"
  _amp_target="$TARGET_DIR/${OOTB_ENV_TARGET:-.env}"
  touch "$_amp_target"
  _amp_i=1
  while :; do
    _amp_var="OOTB_ENV_PROMPT_$_amp_i"
    _amp_item="${!_amp_var:-}"
    [ -z "$_amp_item" ] && break
    _amp_i=$((_amp_i + 1))

    _amp_name="$(echo "$_amp_item" | cut -d: -f1)"
    _amp_desc="$(echo "$_amp_item" | cut -d: -f2)"
    _amp_kind="$(echo "$_amp_item" | cut -d: -f3)"

    has_env_var "$_amp_target" "$_amp_name" && continue

    case "$_amp_kind" in
      generate)
        # 사람이 만들어 붙일 이유가 없는 값(컨테이너끼리만 쓰는 토큰 등)은
        # 붙여넣기를 요구하지 말고 y/N만 묻고 여기서 생성한다. 그래서 문구도
        # secret/plain의 "이 변수에 값을 넣으세요" 모양이 아니라 "이 기능을
        # 켤까요" 모양이어야 한다 - 설명(_amp_desc)은 기능 이름이고, 변수는
        # 그걸 켜는 수단일 뿐이라 앞줄에 따로 보여준다(한글 조사 문제를 피하려고
        # 설명 뒤에 바로 서술을 잇지 않는 것이기도 하다).
        echo "${_amp_indent}[${_amp_name}] ${_amp_desc}"
        if confirm "${_amp_indent}→ 활성화할까요? (${_amp_name} 값은 자동 생성해서 ${OOTB_ENV_TARGET:-.env} 에 저장합니다)" n; then
          set_env_var "$_amp_target" "$_amp_name" "\"$(gen_secret)\""
          echo "${_amp_indent}  활성화했습니다 - ${_amp_name} 값을 새로 생성해 ${OOTB_ENV_TARGET:-.env} 에 저장했습니다."
        else
          set_env_var "$_amp_target" "$_amp_name" ""
          echo "${_amp_indent}  비활성으로 기록했습니다 - 나중에 켜려면 ${OOTB_ENV_TARGET:-.env} 의 ${_amp_name} 줄을 채우세요."
        fi
        ;;
      secret)
        printf '%s%s (%s, 비밀값, 비우면 미설정): ' "$_amp_indent" "$_amp_name" "$_amp_desc"
        read -r -s _amp_val
        echo
        set_env_var "$_amp_target" "$_amp_name" "${_amp_val:+\"$_amp_val\"}"
        ;;
      *)
        printf '%s%s (%s, 비우면 미설정): ' "$_amp_indent" "$_amp_name" "$_amp_desc"
        read -r _amp_val
        set_env_var "$_amp_target" "$_amp_name" "${_amp_val:+\"$_amp_val\"}"
        ;;
    esac
  done
}
