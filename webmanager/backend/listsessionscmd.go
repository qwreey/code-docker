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
// Deliberately silent on any failure - a connection error, a non-OK status,
// a decode error, or (see below) an authgate password requirement all just
// mean "no completions offered" (exit 0, no output), never a scary error or
// a hang firing on every TAB press. Same "non-essential setup degrades
// gracefully" convention as root CLAUDE.md.
func listSessionsCmd(cfg Config) int {
	baseURL := "http://" + cfg.Addr
	client := &http.Client{Timeout: 800 * time.Millisecond}

	statusResp, err := client.Get(baseURL + "/api/auth/status")
	if err != nil {
		return 0
	}
	var status struct {
		Required bool `json:"required"`
	}
	statusErr := json.NewDecoder(statusResp.Body).Decode(&status)
	statusResp.Body.Close()
	if statusErr != nil {
		return 0
	}
	// Unlike attachCmd, there's no terminal here to prompt for a password on
	// - and no cookie jar persisted across separate CLI invocations to reuse
	// one already entered elsewhere. A configured gate just means this
	// command has nothing to offer, not a prompt firing mid-completion.
	if status.Required {
		return 0
	}

	sessionsResp, err := client.Get(baseURL + "/api/terminal/sessions")
	if err != nil {
		return 0
	}
	defer sessionsResp.Body.Close()
	if sessionsResp.StatusCode != http.StatusOK {
		return 0
	}

	var sessions []struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(sessionsResp.Body).Decode(&sessions); err != nil {
		return 0
	}
	for _, s := range sessions {
		fmt.Println(s.Name)
	}
	return 0
}
