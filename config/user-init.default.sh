#!/bin/bash

export HOME="/code"

cp -rn /etc/default/ssh/* /etc/ssh
ssh-keygen -A

fish -c "curl -sL 'https://raw.githubusercontent.com/qwreey/qwreey-fish/refs/heads/main/functions/qs_setup.fish' | source && qs_setup" < /dev/null
