#!/bin/bash
set -e

nginx_config=/etc/code-docker/nginx.default.conf
if [ -e /etc/code-docker/nginx.override.conf ]; then
    nginx_config=/etc/code-docker/nginx.override.conf
fi

# NGINX_LOG_LEVEL (docker-compose.yml) selects the access_log suffix that
# nginx.*.conf's ${NGINX_ACCESS_LOG_IF} placeholder gets envsubst'd with:
#   errors (default) - append " if=$loggable" so only 4xx/5xx responses are
#     logged (see the map block in nginx.*.conf).
#   all - append nothing, logging every request like before this toggle
#     existed.
case "${NGINX_LOG_LEVEL:-errors}" in
    all)
        export NGINX_ACCESS_LOG_IF=""
        ;;
    *)
        export NGINX_ACCESS_LOG_IF=" if=\$loggable"
        ;;
esac

# nginx config files don't do their own env-var substitution, so the chosen
# conf is rendered through envsubst first (gettext, already pulled in by
# base-devel - see build.default.sh) into a runtime copy. Restricted to just
# this one variable name so nginx's own $status/$loggable/$host/etc. in the
# template pass through untouched instead of being blanked out.
generated_config=/run/nginx.generated.conf
envsubst '${NGINX_ACCESS_LOG_IF}' < "$nginx_config" > "$generated_config"

exec nginx -g "daemon off;" -c "$generated_config"
