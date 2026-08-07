#!/bin/bash

# Config defaults
if ! [ -e /etc/ssh/.inited ]; then
    cp -rn /etc/default/ssh/* /etc/ssh
    touch /etc/ssh/.inited
    ssh-keygen -A
fi
if ! [ -e /etc/ssh/sshd_config.d/30-stream-local-bind-unlind.conf ]; then
    echo "StreamLocalBindUnlink yes" > /etc/ssh/sshd_config.d/30-stream-local-bind-unlind.conf
fi

exec /usr/bin/sshd -D
