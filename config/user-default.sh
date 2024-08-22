#!/bin/bash

export HOME="/code"

ZSHFNVM="true"\
ZSHNVM="true"\
ZSHPYENV="true"\
ZSHRUSTUP="true"\
ZSHNOEXEC="true"\
ZSHDIR=/code/.zsh curl https://raw.githubusercontent.com/qwreey/zsh/master/install.zsh | zsh 
