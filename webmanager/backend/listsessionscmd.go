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
// a decode error, or (see below) an authgate password requirement with no
// cached unlock cookie to answer it all just mean "no completions offered"
// (exit 0, no output), never a scary error or a hang firing on every TAB
// press. Same "non-essential setup degrades gracefully" convention as root
// CLAUDE.md.
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
	// There's no terminal here to prompt for a password on, so a configured
	// gate is answered with whatever unlock cookie the last `webmanager
	// --attach` cached (see attachcmd.go's saveAttachCookie) - and with
	// nothing at all if there is none, or it has expired. Without that
	// reuse this command went silent for the entire time the gate was on,
	// which is exactly when `attach`'s completion is most needed: the
	// default session names contain a space, and an unquoted `attach
	// 세션 1` silently creates a session named "세션" instead of joining
	// the one meant.
	cookie := ""
	if status.Required {
		cookie = loadAttachCookie(cfg.AttachCookiePath)
		if cookie == "" {
			return 0
		}
	}

	req, err := http.NewRequest(http.MethodGet, baseURL+"/api/terminal/sessions", nil)
	if err != nil {
		return 0
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	sessionsResp, err := client.Do(req)
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
