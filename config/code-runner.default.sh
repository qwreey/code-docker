#!/bin/bash

eval $($HOME/.local/bin/mise env --shell bash)
TARGET="/code/.server" exec /etc/code-docker/code-server-autoinstall/start.sh
