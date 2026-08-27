#!/bin/bash
# ootb-config.sh - .env(PREFIX/CODE_TZ/리소스 제한/router 바인딩 등)와
# .env.router(tailscale on/off, router-manager 전용 도메인, tinyauth 로그인
# 호스트네임)의 값을 대화형으로
# 설정합니다. ootb.sh(신규 설치)/migrate.sh(RECONFIGURE=1로, 기존 값 보여주고
# 바꿀지부터 물어봄)가 서브프로세스로 호출하지만, 언제든 단독으로도 실행할 수
# 있습니다:
#
#   builds/code-docker/ootb-config.sh              # 새 값 입력(Enter로 스킵)
#   RECONFIGURE=1 builds/code-docker/ootb-config.sh # 현재 값 보여주고 바꿀지부터 확인
#
# 인자로 TARGET_DIR을 주면(ootb.sh/migrate.sh가 이렇게 호출) 위치를 다시 안
# 묻고 바로 그 디렉터리를 씁니다 - 인자가 없으면 대화형으로 확인합니다.

set -u

# shellcheck disable=SC1091
. "$(realpath "$(dirname "$0")")/ootb-lib.sh"

require_cmds awk realpath

resolve_target_dir "${1:-}"

prompt_set() {
  # prompt_set <파일명> <key> <프롬프트 텍스트> - 값을 큰따옴표로 감싸 저장
  # (example-env류가 이미 쓰는 관례: PREFIX="", CODE_TZ="", ... 형태).
  # RECONFIGURE=1이면 현재 값을 보여주고 바꿀지부터 물어본 뒤에만 새 값을 입력받는다.
  #
  # <파일명>은 TARGET_DIR 기준 파일 이름(.env / .env.router)이다 - 이 스크립트는
  # 원래 .env 전용이었지만, 그러면 router 쪽 값(TAILSCALE_ENABLED,
  # ROUTER_MANAGER_HOSTS)은 물어볼 자리가 아예 없어서 ootb로 깔고도 결국
  # .env.router를 손으로 열어야 했다.
  file=$1 key=$2 prompt=$3
  if [ "${RECONFIGURE:-0}" = "1" ]; then
    current="$(get_env_var "$TARGET_DIR/$file" "$key")"
    confirm "  $prompt (현재: ${current:-미설정}) 바꿀까요?" n || return
  fi
  printf '%s: ' "$prompt"
  read -r val
  [ -n "$val" ] && set_env_var "$TARGET_DIR/$file" "$key" "\"$val\""
}

prompt_bool() {
  # prompt_bool <파일명> <key> <프롬프트 텍스트> - "true"/"false"만 갖는 값을
  # y/n으로 물어본다. prompt_set으로 처리하면 사용자가 "false"를 직접 타이핑해야
  # 해서 따로 뒀다. Enter를 누르면 아무 것도 쓰지 않는다 - example-env의 주석
  # 처리된 기본값을 그대로 살려두기 위함이라, 기본값은 prompt_set 호출부들이
  # 이미 쓰는 관례대로 프롬프트 텍스트 안에 적는다("비우면 UTC" 식).
  file=$1 key=$2 prompt=$3
  if [ "${RECONFIGURE:-0}" = "1" ]; then
    current="$(get_env_var "$TARGET_DIR/$file" "$key")"
    confirm "  $prompt (현재: ${current:-미설정}) 바꿀까요?" n || return
  fi
  printf '%s [y/n, Enter면 기본값 유지]: ' "$prompt"
  read -r val
  case "$val" in
    [yY]*) set_env_var "$TARGET_DIR/$file" "$key" '"true"' ;;
    [nN]*) set_env_var "$TARGET_DIR/$file" "$key" '"false"' ;;
  esac
}

echo "=== 환경 값 설정 (Enter로 기본값 유지) ==="
prompt_set .env PREFIX "여러 인스턴스를 한 호스트에 띄울 때 붙일 접두사 (PREFIX)"
prompt_set .env CODE_TZ "타임존 (예: Asia/Seoul, 비우면 UTC)"
prompt_set .env CODE_CPU_LIMIT "code-docker CPU 제한 (예: 4, 비우면 무제한)"
prompt_set .env CODE_MEM_LIMIT "code-docker 메모리 제한 (예: 4g, 비우면 무제한)"
prompt_set .env DIND_CPU_LIMIT "code-docker-dind CPU 제한 (비우면 무제한)"
prompt_set .env DIND_MEM_LIMIT "code-docker-dind 메모리 제한 (비우면 무제한)"
prompt_set .env ROUTER_CPU_LIMIT "code-docker-router CPU 제한 (비우면 무제한)"
prompt_set .env ROUTER_MEM_LIMIT "code-docker-router 메모리 제한 (비우면 무제한)"
prompt_set .env ROUTER_HTTP_BIND "router가 바인딩할 호스트 IP (비우면 0.0.0.0)"
prompt_set .env ROUTER_HTTP_PORT "router가 쓸 호스트 포트 (비우면 80 - 이미 다른 프로세스가 쓰고 있으면 바꾸세요)"
prompt_set .env TRUSTED_PROXIES "신뢰할 리버스 프록시 IP/CIDR 목록 (콤마구분, 비우면 비활성)"
prompt_set .env PWA_NAME "PWA 앱 이름 (여러 인스턴스를 구분하고 싶을 때, 비우면 code-docker)"
prompt_set .env PWA_SHORT_NAME "PWA 짧은 이름 (비우면 code-docker)"
prompt_set .env PWA_DISPLAY_MODE "PWA display 모드 (standalone/fullscreen, 비우면 standalone)"
prompt_set .env CODE_LANG "로케일 (glibc LANG 형식, 예: ko_KR.UTF-8, 비우면 C.UTF-8 - build.*.sh에서 locale-gen 안 하면 C.UTF-8 외 값은 적용 안 됨)"
echo

echo "=== router 설정 (.env.router, Enter로 기본값 유지) ==="
prompt_bool .env.router TAILSCALE_ENABLED "tailscale을 쓸까요? (기본: 사용 - 안 쓸 거면 n을 넣으세요. 끄면 Tailscale 탭이 숨겨지고 데몬도 아무 것도 하지 않습니다)"
prompt_set .env.router ROUTER_MANAGER_HOSTS "router-manager 전용 도메인 (예: router.code.example.com, 비우면 끔 - 설정하면 그 도메인에서만 router-manager를 쓸 수 있고 로그인 쿠키도 그 도메인에만 스코프됩니다. 리버스 프록시 도메인이 아직 없다면 Enter로 건너뛰고 나중에 .env.router에서 설정하세요)"

# 전용 도메인을 실제로 쓰기로 한 경우에만 물어본다 - 안 쓰면 SPA가 열려 있는
# origin이 곧 /app/을 서비스하므로 이 값 자체가 의미가 없고, 안 쓰는 사람에게
# "공유 호스트네임이 뭐냐"고 묻는 건 답을 알 수 없는 질문이다.
# (get_env_var로 방금 쓴 값을 되읽는 이유: prompt_set은 Enter를 누르면 아무
# 것도 쓰지 않아서 반환값만으로는 "이미 설정돼 있었음"과 구분이 안 된다.)
if [ -n "$(get_env_var "$TARGET_DIR/.env.router" ROUTER_MANAGER_HOSTS)" ]; then
  prompt_set .env.router ROUTER_APP_ORIGIN "위 전용 도메인에서도 VNC 뷰어를 열 수 있게 할 공유 호스트네임의 origin (예: https://code.example.com, 비우면 전용 도메인의 VNC 탭에서는 뷰어가 안 뜹니다 - webmanager에 내장된 VNC 탭은 이 값 없이도 동작합니다)"
fi

# tinyauth: 로그인 화면을 서비스할 호스트네임 하나만 물어본다 - TINYAUTH_APPURL은
# 비워두면 여기서 https://<첫 호스트>로 자동 유도되므로(router/config/tinyauth/
# tinyauth.default.sh) 같은 값을 두 번 입력받지 않는다.
prompt_set .env.router TINYAUTH_HOSTS "tinyauth 로그인 화면 호스트네임 (예: auth.example.com, 비우면 끔 - Dev Proxy/App Routes/VNC의 \"인증 요구\"를 쓰려면 반드시 필요합니다. 보호할 대상들과 같은 부모 도메인 아래로 고르면 로그인 한 번으로 전부 커버됩니다)"
echo
