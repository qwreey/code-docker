package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"

	"webmanager/internal/authgate"
)

// hashPasswordCmd implements `webmanager --hash-password`, the CLI helper
// question.md flagged as missing: computing an argon2id hash for
// WEBMANAGER_AUTH_PASSWORD_HASH previously required hand-writing a throwaway
// Go snippet that calls internal/authgate.HashPassword directly. This reuses
// the exact same already-built, already-in-the-image binary (no separate
// build target, no Dockerfile change) rather than shipping a second tool —
// see docker-compose.yml's WEBMANAGER_AUTH_PASSWORD_HASH comment for the
// exact `docker compose exec` invocation this is meant to be run with.
//
// Prompts twice (to catch typos) with echo disabled when stdin is a real
// terminal (docker compose exec -it); falls back to reading one line when
// it's not (piped/scripted input, e.g. `echo pw | docker compose exec -T
// ... --hash-password`) since there's no terminal to disable echo on and no
// second attempt to confirm against anyway. Every prompt/status line goes to
// stderr and the finished hash is the only thing printed to stdout, so
// `HASH=$(docker compose exec -T code-docker /etc/code-docker/webmanager/
// webmanager --hash-password <<< "$pw")` works too.
func hashPasswordCmd() int {
	var password string

	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprint(os.Stderr, "Password: ")
		pw1, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error reading password: %v\n", err)
			return 1
		}
		fmt.Fprint(os.Stderr, "Confirm password: ")
		pw2, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error reading password: %v\n", err)
			return 1
		}
		if string(pw1) != string(pw2) {
			fmt.Fprintln(os.Stderr, "passwords did not match")
			return 1
		}
		password = string(pw1)
	} else {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			fmt.Fprintf(os.Stderr, "error reading password from stdin: %v\n", err)
			return 1
		}
		password = strings.TrimRight(line, "\r\n")
	}

	if password == "" {
		fmt.Fprintln(os.Stderr, "password must not be empty")
		return 1
	}

	hash, err := authgate.HashPassword(password)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error hashing password: %v\n", err)
		return 1
	}

	fmt.Println(hash)
	return 0
}
