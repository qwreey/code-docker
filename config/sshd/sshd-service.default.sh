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

exec /usr/bin/sshd -D
