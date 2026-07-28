#!/bin/bash
set -e

if [ -e /etc/code-docker/shell.override ]; then
    cat /etc/code-docker/shell.override
else
    cat /etc/code-docker/shell.default
fi
