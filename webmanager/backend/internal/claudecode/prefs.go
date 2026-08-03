package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Prefs is the small set of user-customizable Claude Code tab preferences
// persisted backend-side (see internal/terminalsettings for the precedent
// this atomic-write pattern is copied from) — a device-independent
// preference, unlike the localStorage-only collapse/toggle state used
// elsewhere (Extensions.tsx/Mise.tsx).
type Prefs struct {
	HideVersionCheck bool `json:"hideVersionCheck"`
}

// LoadPrefs reads prefs from path. A missing file is not an error — it just
// means "never customized yet", returning zero-value defaults.
func LoadPrefs(path string) (Prefs, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Prefs{}, nil
		}
		return Prefs{}, err
	}
	var p Prefs
	if err := json.Unmarshal(data, &p); err != nil {
		return Prefs{}, err
	}
	return p, nil
}

// SavePrefs writes p atomically: to a temp file in the same directory, then
// os.Rename over the real path, so a reader (or a crash mid-write) never
// sees a partially-written prefs file — same pattern as
// terminalsettings.Save.
func SavePrefs(path string, p Prefs) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".claude-prefs-*.tmp")
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
