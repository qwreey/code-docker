#!/bin/bash

if [ -e /install/package-override.sh ]; then
    /install/package-override.sh
else
    /install/package-default.sh
fi
