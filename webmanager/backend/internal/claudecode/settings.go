package claudecode

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"webmanager/internal/atomicfile"
)

// settingsFileName is the file directly under CLAUDE_CONFIG_DIR holding
// claude's own settings (model, theme, autoCompactEnabled, ...) - no bundled
// schema exists to validate against, and it evolves across CLI releases, so
// this package deliberately treats it as opaque JSON text (see root
// CLAUDE.md's code-server settings.json precedent for the same call).
const settingsFileName = "settings.json"

// ErrInvalidSettingsJSON distinguishes a genuine "the content you submitted
// doesn't parse as a JSON object" rejection from an I/O failure elsewhere in
// WriteSettingsRaw, mirroring gitconfig.ErrInvalidGitConfigSyntax.
var ErrInvalidSettingsJSON = errors.New("invalid settings json")

// ReadSettingsRaw returns the raw contents of CLAUDE_CONFIG_DIR/settings.json
// for the web-based raw editor. A missing file reads as "{}" rather than
// erroring - a fresh install may never have created it, and that's exactly
// what an absent settings file means to claude itself.
func ReadSettingsRaw(configDir string) (string, error) {
	data, err := os.ReadFile(filepath.Join(configDir, settingsFileName))
	if err != nil {
		if os.IsNotExist(err) {
			return "{}", nil
		}
		return "", err
	}
	return string(data), nil
}

// WriteSettingsRaw validates content decodes as a JSON object before
// atomically writing it over CLAUDE_CONFIG_DIR/settings.json, so a typo made
// in the raw editor can't corrupt the file claude itself reads on every
// invocation.
func WriteSettingsRaw(configDir, content string) error {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(content), &obj); err != nil {
		return fmt.Errorf("%w: %s", ErrInvalidSettingsJSON, err.Error())
	}
	return atomicfile.Write(filepath.Join(configDir, settingsFileName), []byte(content), 0o644, 0o755)
}
