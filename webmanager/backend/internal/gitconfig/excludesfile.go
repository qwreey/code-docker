package gitconfig

import (
	"os"
	"path/filepath"
	"strings"
)

// ExcludesFilePath resolves the effective path of the system-wide gitignore
// file core.excludesFile points at, mirroring git's own resolution order: an
// explicit value at gitConfigPath wins, and otherwise git falls back to
// $XDG_CONFIG_HOME/git/ignore (or ~/.config/git/ignore if XDG_CONFIG_HOME is
// unset) — see `man git-config`'s core.excludesFile.
func ExcludesFilePath(gitConfigPath string) (string, error) {
	configured, err := getConfig(gitConfigPath, "core.excludesFile")
	if err != nil {
		return "", err
	}
	if configured != "" {
		return expandTilde(configured)
	}

	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "git", "ignore"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "git", "ignore"), nil
}

// expandTilde resolves a leading "~" or "~/" the same way git itself does
// for core.excludesFile — a configured path using it otherwise wouldn't
// resolve to anything on disk here.
func expandTilde(path string) (string, error) {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if path == "~" {
		return home, nil
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~/")), nil
}

// ReadExcludesFile returns the contents of the global gitignore file at
// path. A missing file reads as "" rather than erroring — it's normal for
// this to not exist yet (git never creates it on its own), mirroring
// ReadRaw's identical convention in raw.go.
func ReadExcludesFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

// WriteExcludesFile writes content to path, creating the parent directory
// first if needed — unlike .gitconfig itself, the default fallback location
// (~/.config/git/ignore) very likely doesn't exist yet on first use.
func WriteExcludesFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o600)
}
