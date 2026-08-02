package files

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// ItemResult is one bulk-operation item's outcome (delete/move/copy),
// mirroring UploadResult's partial-failure shape.
type ItemResult struct {
	Path  string `json:"path"`
	Ok    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// Mkdir creates path (and any missing parents, MkdirAll-style).
func Mkdir(root, userPath string) error {
	resolved, err := ResolveForAccess(root, userPath)
	if err != nil {
		return err
	}
	return os.MkdirAll(resolved, 0o755)
}

// Rename changes path's basename within its current directory (not a move
// across directories — see Move). newName may not contain a path
// separator.
func Rename(root, userPath, newName string) error {
	if newName == "" || strings.ContainsRune(newName, filepath.Separator) || newName == "." || newName == ".." {
		return ErrInvalidName
	}
	resolved, err := ResolveNonRoot(root, userPath)
	if err != nil {
		return err
	}
	dest := filepath.Join(filepath.Dir(resolved), newName)
	if _, err := ResolvePath(root, dest); err != nil {
		return err
	}
	return os.Rename(resolved, dest)
}

// Delete recursively removes each item (os.RemoveAll), continuing past
// per-item failures.
func Delete(root string, items []string) []ItemResult {
	results := make([]ItemResult, 0, len(items))
	for _, item := range items {
		resolved, err := ResolveNonRoot(root, item)
		if err != nil {
			results = append(results, ItemResult{Path: item, Ok: false, Error: err.Error()})
			continue
		}
		if err := os.RemoveAll(resolved); err != nil {
			results = append(results, ItemResult{Path: item, Ok: false, Error: err.Error()})
			continue
		}
		results = append(results, ItemResult{Path: item, Ok: true})
	}
	return results
}

// resolveDestDir validates destDir once for a bulk move/copy call, returning
// either the resolved directory or a set of results (all items marked
// failed with the same error) to short-circuit the caller.
func resolveDestDir(root string, items []string, destDir string) (string, []ItemResult) {
	resolvedDest, err := ResolveForAccess(root, destDir)
	if err != nil {
		return "", failAll(items, err.Error())
	}
	info, err := os.Stat(resolvedDest)
	if err != nil {
		return "", failAll(items, err.Error())
	}
	if !info.IsDir() {
		return "", failAll(items, "destination is not a directory")
	}
	return resolvedDest, nil
}

func failAll(items []string, msg string) []ItemResult {
	results := make([]ItemResult, 0, len(items))
	for _, item := range items {
		results = append(results, ItemResult{Path: item, Ok: false, Error: msg})
	}
	return results
}

// Move relocates each item into destDir, preferring the atomic os.Rename
// and falling back to recursive copy+delete on EXDEV (crossing a
// filesystem boundary — e.g. /code's bind mount vs. the image's own overlay
// filesystem, see filemanager-plan.md's "원자적 이동" section).
func Move(root string, items []string, destDir string) []ItemResult {
	resolvedDest, failed := resolveDestDir(root, items, destDir)
	if failed != nil {
		return failed
	}

	results := make([]ItemResult, 0, len(items))
	for _, item := range items {
		resolvedSrc, err := ResolveNonRoot(root, item)
		if err != nil {
			results = append(results, ItemResult{Path: item, Ok: false, Error: err.Error()})
			continue
		}
		dest := filepath.Join(resolvedDest, filepath.Base(resolvedSrc))
		if _, err := ResolvePath(root, dest); err != nil {
			results = append(results, ItemResult{Path: item, Ok: false, Error: err.Error()})
			continue
		}
		if err := moveOne(resolvedSrc, dest); err != nil {
			results = append(results, ItemResult{Path: item, Ok: false, Error: err.Error()})
			continue
		}
		results = append(results, ItemResult{Path: item, Ok: true})
	}
	return results
}

func moveOne(src, dest string) error {
	err := os.Rename(src, dest)
	if err == nil {
		return nil
	}
	var linkErr *os.LinkError
	if !errors.As(err, &linkErr) || linkErr.Err != syscall.EXDEV {
		return err
	}
	if err := copyPath(src, dest); err != nil {
		return err
	}
	return os.RemoveAll(src)
}

// Copy duplicates each item into destDir, recursively for directories.
func Copy(root string, items []string, destDir string) []ItemResult {
	resolvedDest, failed := resolveDestDir(root, items, destDir)
	if failed != nil {
		return failed
	}

	results := make([]ItemResult, 0, len(items))
	for _, item := range items {
		resolvedSrc, err := ResolveForAccess(root, item)
		if err != nil {
			results = append(results, ItemResult{Path: item, Ok: false, Error: err.Error()})
			continue
		}
		dest := filepath.Join(resolvedDest, filepath.Base(resolvedSrc))
		if _, err := ResolvePath(root, dest); err != nil {
			results = append(results, ItemResult{Path: item, Ok: false, Error: err.Error()})
			continue
		}
		if err := copyPath(resolvedSrc, dest); err != nil {
			results = append(results, ItemResult{Path: item, Ok: false, Error: err.Error()})
			continue
		}
		results = append(results, ItemResult{Path: item, Ok: true})
	}
	return results
}

// copyPath recursively copies src to dest, preserving mode bits and
// re-creating symlinks as links (not following them into a copy of their
// target).
func copyPath(src, dest string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}

	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dest)
	}

	if info.IsDir() {
		if err := os.MkdirAll(dest, info.Mode()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyPath(filepath.Join(src, e.Name()), filepath.Join(dest, e.Name())); err != nil {
				return err
			}
		}
		return os.Chmod(dest, info.Mode())
	}

	return copyFile(src, dest, info.Mode())
}

func copyFile(src, dest string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
