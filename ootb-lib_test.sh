#!/bin/bash
# Tests the pure-shell half of ootb-lib.sh's password prompt: the code-point
# count and ask_new_password's retry/give-up behavior. Run by dev-check.sh
# (every tracked *_test.sh); kept out of the image by .dockerignore. The
# docker half (--hash-password) needs a built image and isn't covered here.
set -u
cd "$(dirname "$0")" || exit 1
# shellcheck disable=SC1091
. ./ootb-lib.sh

failed=0
fail() { echo "FAIL: $*"; failed=1; }

# password_length must count code points whatever the locale says - a C-locale
# bash would count bytes in ${#var}.
for loc in C C.UTF-8 en_US.UTF-8 POSIX; do
  for case in "|0" "abc|3" "abcdefghijk|11" "가나다라마바사아자차카|11" "가나다라마바사아자차카타|12" \
              "한글pass12345!|12" "abcdefghijk😀|12" "é|1"; do
    in=${case%|*} want=${case##*|}
    got=$(LC_ALL=$loc password_length "$in")
    [ "$got" = "$want" ] || fail "password_length '$in' under LC_ALL=$loc = $got, want $want"
  done
done

# ask_new_password reads stdin; run it in a subshell and capture the result.
# $1 = stdin text. Prints "<rc>:<password>".
run_ask() {
  ( printf '%s' "$1" | { ask_new_password >/dev/null 2>&1; rc=$?; printf '%s:%s' "$rc" "$_ootb_new_pw"; } )
}
ok12='가나다라마바사아자차카타'
short11='가나다라마바사아자차카'
nl=$'\n'
expect() { # expect <desc> <stdin> <want>
  got=$(run_ask "$2")
  [ "$got" = "$3" ] || fail "$1: got '$got', want '$3'"
}

expect "matching 12 Korean characters" "$ok12$nl$ok12$nl" "0:$ok12"
expect "11 characters refused, then accepted" "$short11$nl$ok12$nl$ok12$nl" "0:$ok12"
expect "mismatch, then accepted" "$ok12$nl""something-else-1$nl$ok12$nl$ok12$nl" "0:$ok12"
expect "empty answer gives up" "$nl" "1:"
expect "EOF with no input gives up" "" "1:"
expect "EOF after first answer gives up" "$ok12$nl" "1:"
expect "three too-short answers give up" "a${nl}b${nl}c$nl$ok12$nl$ok12$nl" "1:"
# Surrounding spaces and backslashes belong to the password: a plain `read`
# would trim the one and eat the other.
expect "surrounding spaces are kept" "  $ok12  $nl  $ok12  $nl" "0:  $ok12  "
bs='abc\\def\nghijkl'
expect "backslashes are kept" "$bs$nl$bs$nl" "0:$bs"

# The password must never be echoed.
out=$(printf '%s\n%s\n' "$ok12" "$ok12" | ask_new_password 2>&1)
case $out in *"$ok12"*) fail "ask_new_password printed the password" ;; esac

exit $failed
