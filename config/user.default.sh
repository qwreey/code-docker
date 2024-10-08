#!/bin/bash

export HOME="/code"

cp -rn /etc/default/ssh/* /etc/ssh
ssh-keygen -A
curl https://raw.githubusercontent.com/qwreey/zsh/master/install.zsh | ZSHFNVM="true" ZSHNVM="true" ZSHPYENV="true" ZSHRUSTUP="true" ZSHNOEXEC="true" ZSHDIR="/code/.zsh" zsh 
