// Package restartstatus persists a single "code-server restart needed"
// signal that survives frontend navigation/reload, unlike the old one-shot
// local-state prompt shown right after a mise/extension install finishes
// (see webmanager/frontend/src/components/Mise/JobPanel.tsx's history).
//
// The stored state is just the code-server PID observed at the moment a
// mutation that affects it (mise tool install/uninstall, Claude Code
// install/update, code-server extension install/uninstall) completed.
// GET /api/system/restart-needed (handlers_restartstatus.go) compares that
// stored PID against code-server's *current* PID (fetched live from
// supervisord): still equal means code-server hasn't restarted since, so a
// restart is still needed; different (or code-server can't be found at all)
// means it has, so the flag self-clears with no explicit "clear" call
// needed. This also correctly ignores restarts triggered by something other
// than webmanager (e.g. `restart` run by hand in a terminal).
package restartstatus

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// State is the full persisted blob. DirtySincePid is 0 when nothing has
// marked a restart as needed yet.
type State struct {
	DirtySincePid int64 `json:"dirtySincePid"`
}

// Load reads state from path. A missing file is not an error — it just
// means "nothing has marked a restart needed yet", returning a zero-value
// State.
func Load(path string) (State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return State{}, nil
		}
		return State{}, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return State{}, err
	}
	return s, nil
}

// Save writes s atomically: to a temp file in the same directory, then
// os.Rename over the real path — same pattern as internal/terminalsettings.
func Save(path string, s State) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".restart-status-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil {
		os.Remove(tmpPath)
		return writeErr
	}
	if closeErr != nil {
		os.Remove(tmpPath)
		return closeErr
	}

	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}
