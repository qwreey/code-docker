#!/bin/bash

export HOME="/code"

CURR_VERSION=1

# First time init migration
if ! [ -e /code/.installed ]; then
    fish -c "curl -sL 'https://raw.githubusercontent.com/qwreey/qwreey-fish/refs/heads/main/functions/qs_setup.fish' | source && qs_setup" < /dev/null
    echo "$CURR_VERSION" > /code/.installed
fi
if [ "x$(cat /code/.installed)x" = "xx" ]; then
    echo "1" > /code/.installed
fi
