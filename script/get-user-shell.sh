#!/bin/bash
set -e

if [ -e /etc/code-docker/shell/shell.override ]; then
    cat /etc/code-docker/shell/shell.override
else
    cat /etc/code-docker/shell/shell.default
fi
