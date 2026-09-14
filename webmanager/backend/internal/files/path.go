// Package files implements webmanager's file manager API: browsing,
// reading/writing, and mutating (mkdir/rename/move/copy/delete) an
// arbitrary directory tree rooted at a configured path
// (WEBMANAGER_FILES_ROOT). See webmanager/.claude/filemanager-plan.md for
// the full design this package follows.
package files

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
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

// within reports whether p is base itself or lives somewhere beneath it.
//
// Deliberately uses filepath.Rel rather than strings.HasPrefix(p, base): a
// naive prefix check would let "/code-evil" pass a root check for "/code"
// (see filemanager-plan.md's "경로 검증" section) — filepath.Rel respects
// path segment boundaries.
func within(base, p string) bool {
	rel, err := filepath.Rel(base, p)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// ResolvePath validates userPath (an absolute filesystem path as sent by
// the client) against root and returns the cleaned absolute path if it's
// safely contained within root.
//
// This is the *lexical* half only — it says nothing about symlinks. Use
// ResolveForAccess/ResolveNonRoot for anything that then hands the path to
// the OS; ResolvePath on its own is for re-checking a path this package
// itself derived from an already-resolved one (a rename destination, an
// upload destination inside an already-resolved directory).
//
// A root that is itself a symlink is accepted under either spelling (the
// link or its target), since both name the same tree.
func ResolvePath(root, userPath string) (string, error) {
	if userPath == "" {
		userPath = root
	}
	cleaned := filepath.Clean(userPath)
	if !filepath.IsAbs(cleaned) {
		return "", ErrInvalidPath
	}
	if within(filepath.Clean(root), cleaned) {
		return cleaned, nil
	}
	if real, err := filepath.EvalSymlinks(root); err == nil && within(real, cleaned) {
		return cleaned, nil
	}
	return "", ErrInvalidPath
}

// splitUnderRoot resolves root to its real (symlink-free) location and
// returns cleaned's path components relative to it. cleaned may be spelled
// under either the link or the target form of root. A nil parts slice means
// cleaned *is* the root.
func splitUnderRoot(root, cleaned string) (realRoot string, parts []string, err error) {
	realRoot, err = filepath.EvalSymlinks(root)
	if err != nil {
		// The configured root itself is missing or unreadable. Fail loudly
		// rather than silently degrading to a lexical-only check.
		return "", nil, fmt.Errorf("%w: root %q is unresolvable: %v", ErrInvalidPath, root, err)
	}
	for _, base := range []string{realRoot, filepath.Clean(root)} {
		rel, rerr := filepath.Rel(base, cleaned)
		if rerr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		if rel == "." {
			return realRoot, nil, nil
		}
		return realRoot, strings.Split(rel, string(filepath.Separator)), nil
	}
	return "", nil, ErrInvalidPath
}

// resolveLinks walks cleaned one component at a time from the real root,
// resolving every symlink it meets and rejecting (ErrInvalidPath) the
// moment a resolved component lands outside the root. followLeaf decides
// whether the *final* component is resolved too.
//
// Hand-rolled rather than github.com/cyphar/filepath-securejoin on purpose:
// SecureJoin's contract is to *reroot* an escaping symlink target back
// inside the root (treating "/" as the chroot), which would silently write
// to a different file than the one the link names. The file manager and the
// WebDAV share must instead fail loudly — an escaping link is a rejected
// request, not a redirected one — so this walk rejects, and the caller sees
// ErrInvalidPath.
//
// Two deliberate behaviors worth knowing:
//   - Once a component doesn't exist, the walk stops and the remainder is
//     appended as-is: nothing below a missing directory can exist either, so
//     the tail is symlink-free by definition. This is what closes the
//     original hole — filepath.EvalSymlinks fails outright on a nonexistent
//     leaf, and the old code treated that failure as "safe" and returned the
//     unresolved path, so *every* create (mkdir, content PUT, upload dest)
//     followed ancestor symlinks straight out of the root.
//   - A dangling symlink (target doesn't exist) is rejected when followed,
//     rather than being passed through: writing "through" a broken link
//     would create its target, which may be anywhere. Deleting the link
//     entry itself still works, since that path doesn't follow the leaf.
//
// Like every other check here this is TOCTOU-shaped (resolve, then hand the
// path to the OS) rather than openat2-based; same trade-off as before, and
// the same trust model — everything here already runs as root in a
// container whose terminal is a root shell.
func resolveLinks(root, cleaned string, followLeaf bool) (string, error) {
	realRoot, parts, err := splitUnderRoot(root, cleaned)
	if err != nil {
		return "", err
	}

	cur := realRoot
	for i, part := range parts {
		next := filepath.Join(cur, part)

		if i == len(parts)-1 && !followLeaf {
			cur = next
			break
		}

		info, lerr := os.Lstat(next)
		if lerr != nil {
			if errors.Is(lerr, fs.ErrNotExist) {
				cur = next
				if i+1 < len(parts) {
					cur = filepath.Join(next, filepath.Join(parts[i+1:]...))
				}
				break
			}
			// Unreadable ancestor (permission, or a path component that
			// isn't a directory). webmanager runs as root so this is rare;
			// reject rather than guess.
			return "", fmt.Errorf("%w: %v", ErrInvalidPath, lerr)
		}

		if info.Mode()&os.ModeSymlink == 0 {
			cur = next
			continue
		}

		target, eerr := filepath.EvalSymlinks(next)
		if eerr != nil {
			return "", fmt.Errorf("%w: %v", ErrInvalidPath, eerr)
		}
		if !within(realRoot, target) {
			return "", ErrInvalidPath
		}
		cur = target
	}

	if !within(realRoot, cur) {
		return "", ErrInvalidPath
	}
	return cur, nil
}

// resolveEntry validates userPath and resolves every symlink among its
// *ancestors*, leaving the final component alone — the path of an
// operation that acts on the directory entry itself (delete, rename,
// move-source, lstat) rather than reading through it. Deleting a symlink
// removes the link; deleting *through* one is rejected.
func resolveEntry(root, userPath string) (string, error) {
	cleaned, err := ResolvePath(root, userPath)
	if err != nil {
		return "", err
	}
	return resolveLinks(root, cleaned, false)
}

// ResolveNonRoot is resolveEntry plus a guard rejecting the root itself —
// used by delete, rename, and move-source, where operating on the
// configured root would mean destroying/moving the whole scoped tree.
//
// Ancestors are symlink-resolved and re-validated (see resolveLinks); the
// last component is not, so `DELETE /code/Projects/repo/evil` removes the
// escaping link itself while `DELETE /code/Projects/repo/evil/etc/passwd`
// is rejected.
func ResolveNonRoot(root, userPath string) (string, error) {
	cleaned, err := ResolvePath(root, userPath)
	if err != nil {
		return "", err
	}
	_, parts, err := splitUnderRoot(root, cleaned)
	if err != nil {
		return "", err
	}
	if len(parts) == 0 {
		return "", ErrRootPath
	}
	return resolveLinks(root, cleaned, false)
}

// ResolveForAccess is ResolvePath plus full symlink resolution (ancestors
// *and* the final component): used by every operation that reads or writes
// file *content* through a path (list, stat, content get/put, download,
// upload/move/copy destination directories) per filemanager-plan.md's
// "심볼릭 링크" section — a symlink inside root that points outside it must
// not grant access to whatever it points at.
//
// The path need not exist: a create (mkdir, content PUT, upload
// destination) is resolved as far as the filesystem goes and the
// nonexistent tail is kept verbatim, so the caller's own
// os.Stat/os.Open/os.MkdirAll surfaces the concrete not-exist error while
// the ancestors it will actually traverse have already been validated. An
// ancestor that escapes the root is ErrInvalidPath, never a silently
// unresolved path (that fallback was the bug this replaced).
//
// Not used for delete/rename/move-source, which act on the directory entry
// itself (a symlink) rather than reading through it — see ResolveNonRoot.
func ResolveForAccess(root, userPath string) (string, error) {
	cleaned, err := ResolvePath(root, userPath)
	if err != nil {
		return "", err
	}
	return resolveLinks(root, cleaned, true)
}
