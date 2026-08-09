// Package envversionprefs persists the user's "I've seen the env-version
// mismatch banner for this image version" acknowledgement - same purpose as
// webmanager's own internal/envversionprefs, backend-side (not localStorage)
// so it follows the user across browsers/devices.
package envversionprefs

import (
	"encoding/json"
	"os"

	"router/internal/atomicfile"
)

// Dismiss is the full persisted blob. DismissedVersion is compared against
// the image's *current* example-env.router version (not the value the
// user's .env.router itself has) - so a container rebuild that bumps the
// template's version automatically re-arms the banner even if the user
// dismissed a previous version's warning.
type Dismiss struct {
	DismissedVersion string `json:"dismissedVersion"`
}

// Load reads path. A missing file just means "never dismissed", returning a
// zero-value Dismiss (not an error).
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

// Save writes d atomically via internal/atomicfile - same crash-safe
// temp-file+rename webmanager's own envversionprefs hand-rolls itself.
func Save(path string, d Dismiss) error {
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(path, data, 0o644, 0o755)
}
