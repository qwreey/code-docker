// Package browsernames persists user-assigned friendly names for a
// browserId (see internal/sessionheartbeat.Entry.BrowserID) — a small
// id->name JSON document, same "whole-document load/save, no in-memory
// cache" shape as internal/terminalsettings, since writes here are rare
// (a person renaming a device once) and the document is tiny. Unlike
// sessionheartbeat.Store, which is deliberately in-memory only (heartbeats
// re-announce every 30s so losing them on restart is fine), a name someone
// typed in should survive a restart, hence the file.
package browsernames

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Load reads the id->name map from path. A missing file is not an error —
// it just means no device has been named yet.
func Load(path string) (map[string]string, error) {
	names := map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return names, nil
		}
		return names, err
	}
	if err := json.Unmarshal(data, &names); err != nil {
		return map[string]string{}, err
	}
	if names == nil {
		names = map[string]string{}
	}
	return names, nil
}

// Save writes names atomically: to a temp file in the same directory, then
// os.Rename over the real path — same pattern as terminalsettings.Save.
func Save(path string, names map[string]string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(names, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".browser-names-*.tmp")
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
