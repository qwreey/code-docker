#!/bin/bash

if [ -e /install/start-override.sh ]; then
    exec /install/start-override.sh
else
    exec /install/start-default.sh
fi
