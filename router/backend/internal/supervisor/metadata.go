package supervisor

import (
	"os"

	"gopkg.in/yaml.v3"
)

// ProgramMetadata is one entry under the supervisor-metadata file's
// `programs:` key, keyed by supervisord program name. All fields are
// optional; a program not listed gets the zero value (nothing disabled, no
// label/note override).
type ProgramMetadata struct {
	Label          string `yaml:"label" json:"label,omitempty"`
	Note           string `yaml:"note" json:"note,omitempty"`
	DisableStart   bool   `yaml:"disableStart" json:"disableStart"`
	DisableStop    bool   `yaml:"disableStop" json:"disableStop"`
	DisableRestart bool   `yaml:"disableRestart" json:"disableRestart"`
	DisableLogs    bool   `yaml:"disableLogs" json:"disableLogs"`
}

// metadataFile mirrors the full YAML document. Unknown top-level keys are
// ignored by yaml.Unmarshal, not errors.
type metadataFile struct {
	Programs map[string]ProgramMetadata `yaml:"programs"`
}

// LoadMetadata reads overridePath if it exists, else defaultPath — same
// override-then-default-then-empty resolution as extensions.LoadRecommendations
// (see repo root CLAUDE.md's "override pattern"). If neither file exists, or
// either is unparsable, it degrades to an empty map rather than erroring.
func LoadMetadata(defaultPath, overridePath string) (map[string]ProgramMetadata, error) {
	path := defaultPath
	if _, err := os.Stat(overridePath); err == nil {
		path = overridePath
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]ProgramMetadata{}, nil
		}
		return nil, err
	}

	var f metadataFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	if f.Programs == nil {
		f.Programs = map[string]ProgramMetadata{}
	}
	return f.Programs, nil
}
