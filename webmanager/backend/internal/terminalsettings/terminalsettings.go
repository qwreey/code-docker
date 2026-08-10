// Package terminalsettings persists the web terminal's user-customizable
// on-screen keybindings and color themes as a single JSON blob — plain
// file read/write, no database, mirroring how internal/projects persists
// its scan cache (see projects.saveCache).
package terminalsettings

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// KeyBinding is one user-customizable on-screen mobile control button. Bytes
// is the literal byte sequence sent to the PTY when pressed — opaque to the
// backend, the frontend owns its meaning (e.g. "\x1b" for Escape).
type KeyBinding struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Bytes string `json:"bytes"`
}

// TerminalTheme is one user-authored xterm.js color theme. Colors is opaque
// to the backend (xterm.js theme keys -> hex strings) — just stored and
// returned as given.
type TerminalTheme struct {
	ID     string            `json:"id"`
	Name   string            `json:"name"`
	Colors map[string]string `json:"colors"`
}

// Settings is the full persisted blob. CustomThemes holds only
// user-authored themes — built-in presets live in the frontend and are
// never written here. ThemeID may reference either a built-in preset id or
// one of CustomThemes; empty means "frontend picks its own built-in
// default".
type Settings struct {
	Keybindings  []KeyBinding    `json:"keybindings"`
	ThemeID      string          `json:"themeId"`
	CustomThemes []TerminalTheme `json:"customThemes"`
	// HomeLabel overrides the Home tab's displayed title ("홈" if empty).
	// Home is a virtual tab (never a real termsession.Session, see
	// TerminalHome.tsx) with no session record of its own to store a
	// custom name on, so its title rides along in this same
	// already-backend-persisted, already-follows-the-user-across-devices
	// settings blob instead of a new file.
	HomeLabel string `json:"homeLabel"`
	// FontFamily is the selected font-family name for webmanager's own web
	// terminal (see internal/fonts) — empty means "use the built-in
	// var(--mono) stack". Same "rides along in this blob" reasoning as
	// HomeLabel above. Unlike code-server's terminal, which reads its own
	// user settings.json, webmanager's terminal has no such file of its
	// own, so this is applied directly to the xterm.js instance
	// (Terminal.tsx) rather than left for the user to type in somewhere.
	FontFamily string `json:"fontFamily"`
}

func empty() Settings {
	return Settings{Keybindings: []KeyBinding{}, CustomThemes: []TerminalTheme{}}
}

// Load reads settings from path. A missing file is not an error — it just
// means "never customized yet", returning zero-value defaults (empty slices
// rather than null, so they serialize as `[]`).
func Load(path string) (Settings, error) {
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
	if s.Keybindings == nil {
		s.Keybindings = []KeyBinding{}
	}
	if s.CustomThemes == nil {
		s.CustomThemes = []TerminalTheme{}
	}
	return s, nil
}

// Save writes s atomically: to a temp file in the same directory, then
// os.Rename over the real path, so a reader (or a crash mid-write) never
// sees a partially-written settings file — same pattern as
// internal/projects' cache writer.
func Save(path string, s Settings) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".terminal-settings-*.tmp")
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
