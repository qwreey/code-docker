#!/bin/bash

export PATH="/install/bin:$PATH"
if [ -e /install/start-override.sh ]; then
    exec /install/start-override.sh
else
    exec /install/start-default.sh
fi
