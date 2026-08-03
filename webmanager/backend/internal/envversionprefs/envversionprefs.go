// Package envversionprefs persists the user's "I've seen the env-version
// mismatch banner for this image version" acknowledgement. Backend-side
// (not localStorage) so it follows the user across browsers/devices, same
// reasoning as internal/uiprefs' sidebar order — plain JSON file, no
// database. Kept as its own package rather than folded into uiprefs since
// that package is currently hardcoded around SidebarOrder specifically.
package envversionprefs

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Dismiss is the full persisted blob. DismissedVersion is compared against
// the image's *current* example-env.webmanager version (not the value the
// user's .env.webmanager itself has) — so a container rebuild that bumps
// the template's version automatically re-arms the banner even if the user
// dismissed a previous version's warning.
type Dismiss struct {
	DismissedVersion string `json:"dismissedVersion"`
}

// Load reads path. A missing file just means "never dismissed", returning
// a zero-value Dismiss (not an error).
func Load(path string) (Dismiss, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Dismiss{}, nil
		}
		return Dismiss{}, err
	}
	var d Dismiss
	if err := json.Unmarshal(data, &d); err != nil {
		return Dismiss{}, err
	}
	return d, nil
}

// Save writes d atomically (temp file + os.Rename in the same directory),
// same idiom as internal/uiprefs.SaveSidebarOrder/internal/terminalsettings.
func Save(path string, d Dismiss) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".env-version-dismiss-*.tmp")
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
