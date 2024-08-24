#!/bin/bash

export PATH="/install/bin:$PATH"
if [ -e /install/service.override.sh ]; then
    exec /install/service.override.sh
else
    exec /install/service.default.sh
fi
