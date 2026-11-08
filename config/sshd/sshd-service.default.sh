#!/bin/bash
set -e

# Config defaults. The .inited marker is only touched AFTER both steps
# below succeed - touching it first (the old order) meant a failed cp/
# ssh-keygen still marked init as done, so every future boot would skip it
# forever with no host keys and no retry. Every other *-service.default.sh
# in this repo already has `set -e`; this was the one outlier.
if ! [ -e /etc/ssh/.inited ]; then
    cp -rn /etc/default/ssh/* /etc/ssh
    ssh-keygen -A
    touch /etc/ssh/.inited
fi
if ! [ -e /etc/ssh/sshd_config.d/30-stream-local-bind-unlind.conf ]; then
    echo "StreamLocalBindUnlink yes" > /etc/ssh/sshd_config.d/30-stream-local-bind-unlind.conf
fi

# Authentication and forwarding policy, rewritten every start rather than
# seeded once: /etc/ssh is a volume, so a create-only file would never reach
# an existing deployment, and a hand edit there would quietly undo it. The
# one switch is SSHD_PASSWORD_AUTH (example-env); anything else goes in an
# sshd-service.override.sh. sshd keeps the first value it reads for a key and
# sshd_config includes sshd_config.d/*.conf on its first line, so a file
# sorting first here wins over the rest of the config.
#
# This guards against drift and mistakes, not against someone who can write
# this script, the image or the volume - root in the container can always
# start a different sshd.
want=(
    "kbdinteractiveauthentication no"
    "permitemptypasswords no"
    "hostbasedauthentication no"
    "ignorerhosts yes"
    "permituserenvironment no"
    "permittunnel no"
    "gatewayports no"
    "x11forwarding no"
    "strictmodes yes"
    "logingracetime 30"
    "loglevel VERBOSE"
)
case "${SSHD_PASSWORD_AUTH:-false}" in
true)
    want+=("passwordauthentication yes" "permitrootlogin yes" "authenticationmethods any")
    ;;
false)
    want+=("passwordauthentication no" "permitrootlogin prohibit-password" "authenticationmethods publickey")
    ;;
*)
    echo >&2 "sshd: SSHD_PASSWORD_AUTH must be true or false, got '${SSHD_PASSWORD_AUTH}' - not starting"
    exit 1
    ;;
esac

policy=/etc/ssh/sshd_config.d/00-code-docker-policy.conf
{
    echo "# Written by code-docker's sshd-service.default.sh on every start - edits"
    echo "# here are overwritten. See SSHD_PASSWORD_AUTH in example-env."
    printf '%s\n' "${want[@]}"
} >"$policy.tmp"
mv "$policy.tmp" "$policy"

# Check what sshd will actually apply, per connection rather than once: a
# Match block elsewhere in the config can change these for some users or
# addresses only, which a plain `sshd -T` doesn't show. Every account with a
# login shell, against loopback, private, CGNAT (tailscale), public and IPv6
# sources. A Match on something not varied here (LocalPort, RDomain, ...)
# is outside what this sees.
users=$(awk -F: '$7 !~ /(nologin|false)$/ { print $1 }' /etc/passwd)
addrs="127.0.0.1 ::1 10.0.0.1 172.16.0.1 192.168.0.1 100.64.0.1 203.0.113.1 2001:db8::1"
bad=0
for user in $users; do
    for addr in $addrs; do
        spec="user=$user,host=$addr,addr=$addr"
        if ! effective=$(/usr/bin/sshd -T -C "$spec" 2>&1); then
            echo >&2 "sshd: the config does not parse - not starting:"
            echo >&2 "$effective"
            exit 1
        fi
        for line in "${want[@]}"; do
            key=${line%% *}
            value=${line#* }
            got=$(printf '%s\n' "$effective" | awk -v k="$key" 'tolower($1) == k { $1 = ""; sub(/^ /, ""); print; exit }')
            # sshd -T prints prohibit-password under its old name.
            [ "$key" = permitrootlogin ] && [ "$got" = without-password ] && got=prohibit-password
            if [ "${got,,}" != "${value,,}" ]; then
                echo >&2 "sshd: $key is '$got' for $spec, want '$value'"
                bad=1
            fi
        done
    done
done
if [ "$bad" = 1 ]; then
    echo >&2 "sshd: the effective config does not match $policy - something in /etc/ssh overrides it (an earlier-sorting sshd_config.d file, a line above the Include, or a Match block). Not starting."
    exit 1
fi

# -e: there is no syslog in this container, so without it every connection
# and authentication record (and the key fingerprints LogLevel VERBOSE adds)
# was dropped. On stderr they reach supervisord's log and so vector.
exec /usr/bin/sshd -D -e
