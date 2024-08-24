#!/bin/bash

if [ -e /install/build.override.sh ]; then
    /install/build.override.sh
else
    /install/build.default.sh
fi
