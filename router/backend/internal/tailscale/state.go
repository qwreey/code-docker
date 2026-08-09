// Package tailscale provides router-manager's read-only view of this
// container's tailscaled instance. Replaces the old
// tailscale-status.default.sh (which polled `tailscale status --json` and
// wrote a status.json file for code-server's tailscale-notify.js to poll
// same-origin) with a real HTTP endpoint instead - see
// .claude/functional-router-plan.md's "읽기전용 상태 API".
package tailscale

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"
)

// State is intentionally the same shape tailscale-status.default.sh used to
// write to status.json, so nginx's future /tailscale/ proxy + code-server's
// tailscale-notify.js can switch to this endpoint with no payload-shape
// change on the frontend side. Enabled was added later (additive, existing
// consumers that don't read it are unaffected).
type State struct {
	BackendState string  `json:"backendState"`
	AuthURL      *string `json:"authUrl"`
	Enabled      bool    `json:"enabled"`
}

type rawStatus struct {
	BackendState string `json:"BackendState"`
	AuthURL      string `json:"AuthURL"`
}

// GetState shells out to `tailscale status --json`, same as
// tailscale-status.default.sh did. A 5s timeout matches webmanager's own
// internal/tailscale/status.go precedent for the same command.
//
// TAILSCALE_ENABLED=false short-circuits before that exec - tailscaled was
// never started (see tailscale-service.default.sh), so the CLI call would
// just fail with a generic "no daemon socket" error indistinguishable from
// "enabled but not ready yet". Reporting Enabled: false explicitly instead
// is what lets code-server's tailscale-notify.js banner stop nagging for a
// login that was deliberately never going to happen.
func GetState(ctx context.Context) (State, error) {
	if !Enabled() {
		return State{BackendState: "Disabled", Enabled: false}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "tailscale", "status", "--json").Output()
	if err != nil {
		return State{}, err
	}

	var raw rawStatus
	if err := json.Unmarshal(out, &raw); err != nil {
		return State{}, err
	}

	state := State{BackendState: raw.BackendState, Enabled: true}
	if raw.AuthURL != "" {
		state.AuthURL = &raw.AuthURL
	}
	return state, nil
}
