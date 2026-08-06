package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"

	"router/internal/authgate"
)

// hashPasswordCmd implements `router-manager --hash-password`, computing an
// argon2id hash for ROUTER_MANAGER_AUTH_PASSWORD_HASH. Mirrors webmanager's
// own `webmanager --hash-password` (same reasoning: reuse the already-built
// binary rather than shipping a second tool) — see example-env's
// ROUTER_MANAGER_AUTH_PASSWORD_HASH comment for the exact `docker compose
// exec` invocation this is meant to be run with.
//
// Prompts twice (to catch typos) with echo disabled when stdin is a real
// terminal; falls back to reading one line when it's not (piped/scripted
// input). Every prompt/status line goes to stderr and the finished hash is
// the only thing printed to stdout.
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
