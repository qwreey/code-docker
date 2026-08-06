package authgate

import (
	"bufio"
	"os"
	"strings"
)

// EtcEnvironmentDefines reports whether varName is also defined in
// /etc/environment (format: KEY=value or KEY="value" per line — a simple
// per-line "VARNAME=" prefix check is sufficient, no shell-quoting parser
// needed).
//
// Defensive cross-check: the whole point of storing the password hash only
// in a process-start-time env var is that changing it requires host-side
// access to docker-compose.yml/.env, not just container shell access. If
// the same variable is also defined in /etc/environment, that's a signal
// something inside the container tried to make an attacker-controlled value
// look like it came from the trusted path — callers should refuse to honor
// the env var in that case.
//
// Returns false (not defined / not tampered) if the file can't be read at
// all, since most containers won't even have this file populated.
func EtcEnvironmentDefines(varName string) bool {
	f, err := os.Open("/etc/environment")
	if err != nil {
		return false
	}
	defer f.Close()

	prefix := varName + "="
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if strings.HasPrefix(strings.TrimSpace(scanner.Text()), prefix) {
			return true
		}
	}
	return false
}
