package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// claudeJSONFileName is fixed at $HOME/.claude.json - unlike everything
// under CLAUDE_CONFIG_DIR (settings.json, credentials, sessions/), the CLI
// has never made this one relocatable.
const claudeJSONFileName = ".claude.json"

// HasCompletedOnboarding reports whether ~/.claude.json's own
// hasCompletedOnboarding flag is true. This is deliberately NOT the same
// thing as GetAuthStatus's loggedIn - confirmed live (see root CLAUDE.md's
// webmanager section): loggedIn flips true the moment the OAuth handshake
// completes, but the interactive CLI still shows a few more onboarding
// screens after that (a "press Enter to continue," then a security notice)
// before it actually sets this flag. It's this flag, not loggedIn, that
// gates whether a later bare `claude` launch shows its first-run wizard
// again - so it's the correct signal for
// InteractiveLoginManager-driven flows to wait for before closing, and the
// correct check for deciding whether the interactive wizard is even needed
// at all (already-onboarded means the plain headless `claude auth login`
// flow, see login.go, is sufficient on its own). A missing/unreadable/
// unparseable file just means "never onboarded yet" (false, no error) -
// this is the normal state for a fresh container.
func HasCompletedOnboarding() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	data, err := os.ReadFile(filepath.Join(home, claudeJSONFileName))
	if err != nil {
		return false
	}
	var doc struct {
		HasCompletedOnboarding bool `json:"hasCompletedOnboarding"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return false
	}
	return doc.HasCompletedOnboarding
}
