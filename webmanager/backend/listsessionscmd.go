package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// listSessionsCmd implements `webmanager --list-sessions` - prints the name
// of every currently registered terminal session, one per line, and nothing
// else. It exists purely as a fast, non-interactive data source for shell
// completion (see config/shell/completions/attach.fish) to shell out to,
// rather than re-implementing the HTTP call + JSON decoding once per shell
// (fish/bash/zsh) in their own completion languages.
//
// Reads GET /api/terminal/session-names, which is deliberately outside the
// password gate (see handleListTerminalSessionNames) - so this works the
// same whether or not the gate is on, with no password prompt and no cached
// unlock cookie. (An earlier version reused a cookie the last `attach` had
// cached on disk, and so still went silent whenever that cookie was missing
// or had expired - most of the time.)
//
// Deliberately silent on any failure - a connection error, a non-OK status
// or a decode error all just mean "no completions offered" (exit 0, no
// output), never a scary error or a hang firing on every TAB press. Same
// "non-essential setup degrades gracefully" convention as root CLAUDE.md.
func listSessionsCmd(cfg Config) int {
	client := &http.Client{Timeout: 800 * time.Millisecond}
	names, err := fetchSessionNames(client, "http://"+cfg.Addr)
	if err != nil {
		return 0
	}
	for _, name := range names {
		fmt.Println(name)
	}
	return 0
}

// fetchSessionNames returns the names of every live terminal session, via
// the ungated names-only endpoint. Shared by listSessionsCmd and attach's
// sessionExists.
func fetchSessionNames(client *http.Client, baseURL string) ([]string, error) {
	resp, err := client.Get(baseURL + "/api/terminal/session-names")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	var names []string
	if err := json.NewDecoder(resp.Body).Decode(&names); err != nil {
		return nil, err
	}
	return names, nil
}
