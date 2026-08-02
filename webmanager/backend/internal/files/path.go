// Package files implements webmanager's file manager API: browsing,
// reading/writing, and mutating (mkdir/rename/move/copy/delete) an
// arbitrary directory tree rooted at a configured path
// (WEBMANAGER_FILES_ROOT). See webmanager/.claude/filemanager-plan.md for
// the full design this package follows.
package files

import (
	"errors"
	"path/filepath"
	"strings"
)

var (
	// ErrInvalidPath is returned when a user-supplied path isn't an
	// absolute path, or resolves outside the configured root.
	ErrInvalidPath = errors.New("files: path is invalid or escapes root")
	// ErrRootPath is returned when a destructive single-target operation
	// (delete/rename/move-source) targets the root itself.
	ErrRootPath = errors.New("files: operation not allowed on the configured root")
	// ErrNotDir / ErrIsDir are returned when an operation expected the
	// opposite of what it found (e.g. list() on a file, content() on a
	// directory).
	ErrNotDir = errors.New("files: not a directory")
	ErrIsDir  = errors.New("files: is a directory")
	// ErrInvalidName is returned for an empty/`.`/`..`/separator-containing
	// name in rename or upload.
	ErrInvalidName = errors.New("files: invalid name")
)

// ResolvePath validates userPath (an absolute filesystem path as sent by
// the client) against root and returns the cleaned absolute path if it's
// safely contained within root.
//
// Deliberately uses filepath.Rel rather than strings.HasPrefix(cleaned,
// root): a naive prefix check would let "/code-evil" pass a root check for
// "/code" (see filemanager-plan.md's "경로 검증" section) — filepath.Rel
// respects path segment boundaries.
func ResolvePath(root, userPath string) (string, error) {
	if userPath == "" {
		userPath = root
	}
	cleaned := filepath.Clean(userPath)
	if !filepath.IsAbs(cleaned) {
		return "", ErrInvalidPath
	}
	rel, err := filepath.Rel(root, cleaned)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrInvalidPath
	}
	return cleaned, nil
}

// ResolveNonRoot is ResolvePath plus a guard rejecting the root itself —
// used by delete, rename, and move-source, where operating on the
// configured root would mean destroying/moving the whole scoped tree.
func ResolveNonRoot(root, userPath string) (string, error) {
	resolved, err := ResolvePath(root, userPath)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil {
		return "", ErrInvalidPath
	}
	if rel == "." {
		return "", ErrRootPath
	}
	return resolved, nil
}

// ResolveForAccess is ResolvePath plus symlink-aware re-validation: used by
// every operation that reads or writes file *content* through a path
// (list, stat, content get/put, download, upload/move/copy destination
// directories) per filemanager-plan.md's "심볼릭 링크" section — a symlink
// inside root that points outside it must not grant access to whatever it
// points at.
//
// If the path doesn't exist yet (e.g. a new file for PUT content, or an
// as-yet-nonexistent upload destination checked before creation) or an
// ancestor is unreadable, EvalSymlinks fails and this simply returns the
// already-validated (but unresolved) path — the caller's own
// os.Stat/os.Open will surface the concrete not-exist/permission error.
//
// Not used for delete/rename/move-source, which act on the directory entry
// itself (a symlink) rather than reading through it — see ResolveNonRoot.
func ResolveForAccess(root, userPath string) (string, error) {
	resolved, err := ResolvePath(root, userPath)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		return resolved, nil
	}
	if real == resolved {
		return resolved, nil
	}
	return ResolvePath(root, real)
}
