// Package terminalprofiles persists the web terminal Home tab's user-defined
// launch profiles (a label plus an optional working directory and/or initial
// command) as a single JSON blob — same plain read/write pattern as
// internal/terminalsettings, no database.
package terminalprofiles

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Profile is one user-defined "open a terminal like this" preset. Cwd and
// Command are both optional and independent — a profile can set either,
// both, or neither (in which case it behaves like a plain new session).
type Profile struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Cwd     string `json:"cwd,omitempty"`
	Command string `json:"command,omitempty"`
}

// Document is the full persisted blob.
type Document struct {
	Profiles []Profile `json:"profiles"`
}

func empty() Document {
	return Document{Profiles: []Profile{}}
}

// Load reads profiles from path. A missing file just means "none defined
// yet", returning an empty (not null) list.
func Load(path string) (Document, error) {
	d := empty()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return d, nil
		}
		return d, err
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return empty(), err
	}
	if d.Profiles == nil {
		d.Profiles = []Profile{}
	}
	return d, nil
}

// Save writes d atomically: temp file in the same directory, then
// os.Rename over the real path — same pattern as terminalsettings.Save.
func Save(path string, d Document) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".terminal-profiles-*.tmp")
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
