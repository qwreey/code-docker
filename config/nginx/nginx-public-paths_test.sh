#!/bin/bash
# Checks nginx.default.conf's $code_docker_public_escaped map against requests
# that must and must not be refused. Run by dev-check.sh (every tracked
# *_test.sh); kept out of the image by .dockerignore.
#
# The patterns are read straight out of the config, so this tests what nginx
# actually gets. pcre2grep stands in for nginx's PCRE (-i for the map's ~*), and
# each sample is the map's key: the raw request URI, a space, then the $uri
# nginx normalizes it to. -M plus printf '%s' make the whole sample one subject,
# as in nginx, so a $uri ending in a decoded newline can be tested too.
set -u
cd "$(dirname "$0")" || exit 1

mapfile -t patterns < <(sed -n '/\$code_docker_public_escaped {$/,/^ *}$/s/^ *"~\*\(.*\)" 1;$/\1/p' nginx.default.conf)
if [ ${#patterns[@]} -lt 2 ]; then
    echo "found only ${#patterns[@]} patterns in \$code_docker_public_escaped - did its layout change?" >&2
    exit 1
fi

escaped() {
    local p
    for p in "${patterns[@]}"; do
        printf '%s' "$1" | pcre2grep -M -i -q -- "$p" && return 0
    done
    return 1
}

failed=0
while IFS= read -r sample; do
    escaped "$sample" || { echo "should be refused but passes: $sample"; failed=1; }
done <<'EOF'
/_static/../manager/ /manager/
/_static/..%2fmanager/ /manager/
/_static/%2e%2e/manager/ /manager/
/_static/%2E%2E%2Fmanager/ /manager/
/_static/out/../../manager/ /manager/
/_static//../manager/ /manager/
/_static/./../manager/ /manager/
/_static/.. /
/_static/..%2fmanager/?a=/_static/ /manager/
/_static/../_staticfoo/ /_staticfoo/
/_static%2f..%2fmanager/ /manager/
/_static /_static
/_staticfoo /_staticfoo
/_STATIC/../manager/ /manager/
/manifest.json/../manager/ /manager/
/manifest.json/..%2fmanager/ /manager/
/manifest.json%2f..%2fmanager/ /manager/
/manifest.json/%2e%2e /
/manifest.json/ /manifest.json/
/manifest.json/. /manifest.json/
/manifest.json.bak /manifest.json.bak
/MANIFEST.JSON/../manager/ /manager/
EOF

# Samples that can't be typed into the heredoc above: raw control characters
# nginx lets through in a URI (each popped by the ../ after it), and a $uri
# ending in a decoded newline, which $ would have accepted as /manifest.json.
for ctl in $'\t' $'\v' $'\f'; do
    for sample in "/_static/$ctl/..%2fmanager/ /manager/" "/manifest.json/$ctl/../../manager/ /manager/"; do
        escaped "$sample" || { echo "should be refused but passes: $(printf '%q' "$sample")"; failed=1; }
    done
done
sample=$'/manifest.json%0a /manifest.json\n'
escaped "$sample" || { echo "should be refused but passes: $(printf '%q' "$sample")"; failed=1; }

while IFS= read -r sample; do
    escaped "$sample" && { echo "should pass but is refused: $sample"; failed=1; }
done <<'EOF'
/ /
/manager/ /manager/
/stable-0123abcd/static/out/vs/code/browser/workbench/workbench.js /stable-0123abcd/static/out/vs/code/browser/workbench/workbench.js
/_static/out/browser/serviceWorker.js /_static/out/browser/serviceWorker.js
/_static/src/browser/media/pwa-icon-192.png /_static/src/browser/media/pwa-icon-192.png
/_static/lib/vscode/out/vs/patch/icons/pwa-icon-512.png /_static/lib/vscode/out/vs/patch/icons/pwa-icon-512.png
/_static/out/./browser/x.js /_static/out/browser/x.js
/_static//out/x.js /_static/out/x.js
/_static/out/../src/x.png /_static/src/x.png
/_static/x.js?y=/../../manager/ /_static/x.js
/_STATIC/out/x.js /_STATIC/out/x.js
/x/../_static/out/x.js /_static/out/x.js
/manifest.json /manifest.json
/manifest.json?v=1&x=/../manager/ /manifest.json
/MANIFEST.JSON /MANIFEST.JSON
/x/../manifest.json /manifest.json
/manifest.webmanifest /manifest.webmanifest
EOF
exit $failed
