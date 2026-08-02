package projects

import (
	_ "embed"
	"log"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// defaultPatternsYAML is the built-in reclaimable directory-name pattern
// list, embedded so the binary needs no baked-in file to have a working
// default. Deliberately not following the repo-root Dockerfile-baked
// override pattern (config/<name>.default.* + rebuild) — this is a small,
// user-tunable list and requiring an image rebuild to add one pattern would
// be poor ergonomics for what it's worth. Instead it's seeded, on first
// read, as an editable copy at ProjectsPatternsPath.
//
//go:embed default_patterns.yaml
var defaultPatternsYAML []byte

// builtinPatterns is always active, independent of patternsFile — user
// patterns from disk are additive, never a replacement for these.
var builtinPatterns = []string{
	"node_modules", "target", ".venv", "venv", "__pycache__",
	"dist", "build", ".next", ".nuxt", ".turbo", ".gradle", ".cache",
}

type patternsFile struct {
	Patterns []string `yaml:"patterns"`
}

// loadPatterns reads path (writing the embedded default there first if it
// doesn't exist yet) and merges its patterns list with builtinPatterns.
func loadPatterns(path string) map[string]struct{} {
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("projects: reading patterns file %s: %v", path, err)
			data = defaultPatternsYAML
		} else {
			if mkErr := os.MkdirAll(filepath.Dir(path), 0o755); mkErr != nil {
				log.Printf("projects: creating patterns dir for %s: %v", path, mkErr)
			} else if writeErr := os.WriteFile(path, defaultPatternsYAML, 0o644); writeErr != nil {
				log.Printf("projects: seeding patterns file %s: %v", path, writeErr)
			}
			data = defaultPatternsYAML
		}
	}

	var pf patternsFile
	if err := yaml.Unmarshal(data, &pf); err != nil {
		log.Printf("projects: parsing patterns file %s: %v", path, err)
	}

	result := make(map[string]struct{}, len(builtinPatterns)+len(pf.Patterns))
	for _, p := range builtinPatterns {
		result[p] = struct{}{}
	}
	for _, p := range pf.Patterns {
		if p != "" {
			result[p] = struct{}{}
		}
	}
	return result
}
