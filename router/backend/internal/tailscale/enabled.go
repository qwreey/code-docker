package tailscale

import "os"

// Enabled mirrors the shell-script opt-out idiom every tailscale
// supervisord program already uses (tailscale-service.default.sh et al:
// `${TAILSCALE_ENABLED:-true}`) so router-manager's API surface can report
// the same "off" signal explicitly, instead of every caller having to infer
// "disabled" from a bare exec failure (state.go/status.go) that looks
// identical to "enabled but daemon still starting / not logged in yet".
func Enabled() bool {
	return os.Getenv("TAILSCALE_ENABLED") != "false"
}
