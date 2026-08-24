#!/bin/bash
# ootb-config.sh - .env의 값(PREFIX/CODE_TZ/리소스 제한/router 바인딩 등)을 대화형으로
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
  # prompt_set <key> <프롬프트 텍스트> - 값을 큰따옴표로 감싸 저장 (example-env류가
  # 이미 쓰는 관례: PREFIX="", CODE_TZ="", ... 형태). RECONFIGURE=1이면 현재 값을 보여주고
  # 바꿀지부터 물어본 뒤에만 새 값을 입력받는다.
  key=$1 prompt=$2
  if [ "${RECONFIGURE:-0}" = "1" ]; then
    current="$(get_env_var "$TARGET_DIR/.env" "$key")"
    confirm "  $prompt (현재: ${current:-미설정}) 바꿀까요?" n || return
  fi
  printf '%s: ' "$prompt"
  read -r val
  [ -n "$val" ] && set_env_var "$TARGET_DIR/.env" "$key" "\"$val\""
}

echo "=== 환경 값 설정 (Enter로 기본값 유지) ==="
prompt_set PREFIX "여러 인스턴스를 한 호스트에 띄울 때 붙일 접두사 (PREFIX)"
prompt_set CODE_TZ "타임존 (예: Asia/Seoul, 비우면 UTC)"
prompt_set CODE_CPU_LIMIT "code-docker CPU 제한 (예: 4, 비우면 무제한)"
prompt_set CODE_MEM_LIMIT "code-docker 메모리 제한 (예: 4g, 비우면 무제한)"
prompt_set DIND_CPU_LIMIT "code-docker-dind CPU 제한 (비우면 무제한)"
prompt_set DIND_MEM_LIMIT "code-docker-dind 메모리 제한 (비우면 무제한)"
prompt_set ROUTER_CPU_LIMIT "code-docker-router CPU 제한 (비우면 무제한)"
prompt_set ROUTER_MEM_LIMIT "code-docker-router 메모리 제한 (비우면 무제한)"
prompt_set ROUTER_HTTP_BIND "router가 바인딩할 호스트 IP (비우면 0.0.0.0)"
prompt_set ROUTER_HTTP_PORT "router가 쓸 호스트 포트 (비우면 80 - 이미 다른 프로세스가 쓰고 있으면 바꾸세요)"
prompt_set TRUSTED_PROXIES "신뢰할 리버스 프록시 IP/CIDR 목록 (콤마구분, 비우면 비활성)"
prompt_set PWA_NAME "PWA 앱 이름 (여러 인스턴스를 구분하고 싶을 때, 비우면 code-docker)"
prompt_set PWA_SHORT_NAME "PWA 짧은 이름 (비우면 code-docker)"
prompt_set PWA_DISPLAY_MODE "PWA display 모드 (standalone/fullscreen, 비우면 standalone)"
prompt_set CODE_LANG "로케일 (glibc LANG 형식, 예: ko_KR.UTF-8, 비우면 C.UTF-8 - build.*.sh에서 locale-gen 안 하면 C.UTF-8 외 값은 적용 안 됨)"
echo
