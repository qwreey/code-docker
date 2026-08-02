// Package uiprefs persists small, purely-cosmetic frontend preferences that
// still benefit from surviving a browser/device switch (unlike the
// localStorage-based per-browser toggles elsewhere in this codebase) — right
// now just the sidebar's user-chosen tab order. Plain JSON file read/write,
// no database, mirroring internal/terminalsettings' pattern. Not gated by
// internal/authgate: reordering tabs has no security relevance.
package uiprefs

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// SidebarOrder is the full persisted blob: Order is a list of SectionId
// strings (opaque to the backend — the frontend owns what's a valid id) in
// the user's chosen display order. Missing/unknown ids are the frontend's
// concern to reconcile against its own current section list, not this
// package's.
type SidebarOrder struct {
	Order []string `json:"order"`
}

func empty() SidebarOrder {
	return SidebarOrder{Order: []string{}}
}

// LoadSidebarOrder reads path. A missing file just means "never
// reordered yet", returning an empty order (not an error).
func LoadSidebarOrder(path string) (SidebarOrder, error) {
	s := empty()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return s, err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return empty(), err
	}
	if s.Order == nil {
		s.Order = []string{}
	}
	return s, nil
}

// maxOrderEntries is a defensive cap — this repo has a couple dozen
// sections at most, so a request claiming hundreds of entries is either a
// bug or abuse, not a legitimate reorder. Silently truncated rather than
// rejected outright since this is a purely cosmetic preference, not
// something worth failing a request over.
const maxOrderEntries = 200

// SaveSidebarOrder writes s atomically (temp file + os.Rename in the same
// directory), same idiom as internal/terminalsettings.Save.
func SaveSidebarOrder(path string, s SidebarOrder) error {
	if s.Order == nil {
		s.Order = []string{}
	}
	if len(s.Order) > maxOrderEntries {
		s.Order = s.Order[:maxOrderEntries]
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".sidebar-order-*.tmp")
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
