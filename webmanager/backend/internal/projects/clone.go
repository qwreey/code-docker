package projects

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

var (
	// ErrUnknownRoot is returned when a caller-supplied root doesn't exactly
	// match one of the Scanner's configured paths — same exact-match
	// convention as IsKnownPath, applied to roots instead of full project
	// paths (a fresh clone has no cached project entry yet to match against).
	ErrUnknownRoot = errors.New("unknown project root")
	// ErrInvalidCloneName is returned by ValidateCloneName when name isn't a
	// safe, single-segment destination folder name.
	ErrInvalidCloneName = errors.New("name must be a single path segment (letters, numbers, dot, underscore, dash, starting with a letter or number)")
	// ErrCloneDestExists is returned when the resolved destination already
	// exists on disk.
	ErrCloneDestExists = errors.New("destination already exists")
)

// cloneNameRe mirrors mise.toolIDRe/versionRe's convention (a leading `-`
// could otherwise be misparsed as a flag) but is stricter: no `/` at all, so
// a caller-supplied name can never escape the chosen root via a path
// separator, mirroring the "exact-match against a known-good set" validation
// every other project-mutation method in this file uses — here there's
// nothing to match against yet (the destination doesn't exist), so a strict
// charset allowlist is the closest equivalent.
var cloneNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// ValidateCloneName reports whether name is safe to use as a single new
// subdirectory name directly under an already-known root.
func ValidateCloneName(name string) error {
	if !cloneNameRe.MatchString(name) || name == "." || name == ".." {
		return ErrInvalidCloneName
	}
	return nil
}

// IsKnownRoot reports whether root exactly matches one of the Scanner's
// configured scan roots — never a prefix/contains check, same convention as
// IsKnownPath.
func (s *Scanner) IsKnownRoot(root string) bool {
	for _, p := range s.paths {
		if p == root {
			return true
		}
	}
	return false
}

// DefaultRoot returns the first configured scan root, for callers (the
// clone dialog) that don't need to ask the user to pick one when only a
// single root is configured. ok is false if no root is configured at all.
func (s *Scanner) DefaultRoot() (string, bool) {
	if len(s.paths) == 0 {
		return "", false
	}
	return s.paths[0], true
}

// PrepareClone validates root and name and returns the destination path a
// `git clone` should target. root must exactly match a configured scan root
// (ErrUnknownRoot) and name must pass ValidateCloneName. The resolved
// destination must not already exist (ErrCloneDestExists) — git itself
// refuses to clone into a non-empty directory, but checking here up front
// gives a clearer error than parsing git's own stderr for it, and the
// filepath.Dir check below defends against name resolving outside root even
// though cloneNameRe already rejects any `/`.
func (s *Scanner) PrepareClone(root, name string) (string, error) {
	if !s.IsKnownRoot(root) {
		return "", ErrUnknownRoot
	}
	if err := ValidateCloneName(name); err != nil {
		return "", err
	}

	dest := filepath.Join(root, name)
	if filepath.Dir(dest) != root {
		return "", ErrInvalidCloneName
	}

	if _, err := os.Stat(dest); err == nil {
		return "", ErrCloneDestExists
	} else if !os.IsNotExist(err) {
		return "", err
	}

	return dest, nil
}
