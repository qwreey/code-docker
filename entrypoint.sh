#!/bin/bash

mkdir -p /code/.local
mkdir -p /code/.local/share/sshd
ln -s /code/.local/share/sshd /etc/ssh
if [ -e /install/supervisord.override.conf ]; then
    exec /sbin/supervisord -n -c /install/supervisord.override.conf --user root
else
    exec /sbin/supervisord -n -c /install/supervisord.default.conf --user root
fi
