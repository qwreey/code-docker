#!/bin/bash

export HOME="/code"

curl https://raw.githubusercontent.com/qwreey/zsh/master/install.zsh | ZSHFNVM="true" ZSHNVM="true" ZSHPYENV="true" ZSHRUSTUP="true" ZSHNOEXEC="true" ZSHDIR="/code/.zsh" zsh 
