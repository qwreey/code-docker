#!/bin/bash
set -e

if [ -e /etc/code-docker/sshd/sshd-service.override.sh ]; then
    exec /etc/code-docker/sshd/sshd-service.override.sh
else
    exec /etc/code-docker/sshd/sshd-service.default.sh
fi
