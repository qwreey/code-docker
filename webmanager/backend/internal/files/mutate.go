package files

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// ItemResult is one bulk-operation item's outcome (delete/move/copy),
// mirroring UploadResult's partial-failure shape. Exists marks a failure
// that only means "the destination is already there": the client can ask
// whether to overwrite and send just those items again with overwrite set.
type ItemResult struct {
	Path   string `json:"path"`
	Ok     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Exists bool   `json:"exists,omitempty"`
}

func itemResult(path string, err error) ItemResult {
	if err != nil {
		return ItemResult{Path: path, Ok: false, Error: err.Error(), Exists: errors.Is(err, ErrExists)}
	}
	return ItemResult{Path: path, Ok: true}
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
// separator. An existing entry under newName is replaced only when
// overwrite is set; otherwise the result is ErrExists.
func Rename(root, userPath, newName string, overwrite bool) error {
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
	if dest == resolved {
		return nil
	}
	return rename(resolved, dest, overwrite)
}

// rename is os.Rename, or with overwrite unset, a rename that fails with
// ErrExists instead of replacing an existing destination. That is
// renameat2(RENAME_NOREPLACE), atomic against something appearing at dest
// in between; a filesystem without it gets a check-then-rename.
func rename(src, dest string, overwrite bool) error {
	if overwrite {
		return os.Rename(src, dest)
	}
	err := unix.Renameat2(unix.AT_FDCWD, src, unix.AT_FDCWD, dest, unix.RENAME_NOREPLACE)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, unix.EEXIST):
		return ErrExists
	case errors.Is(err, unix.EINVAL), errors.Is(err, unix.ENOSYS), errors.Is(err, unix.EOPNOTSUPP):
		if _, lerr := os.Lstat(dest); lerr == nil {
			return ErrExists
		}
		return os.Rename(src, dest)
	default:
		return &os.LinkError{Op: "rename", Old: src, New: dest, Err: err}
	}
}

// Delete recursively removes each item (os.RemoveAll), continuing past
// per-item failures.
func Delete(root string, items []string) []ItemResult {
	results := make([]ItemResult, 0, len(items))
	for _, item := range items {
		resolved, err := ResolveNonRoot(root, item)
		if err == nil {
			err = os.RemoveAll(resolved)
		}
		results = append(results, itemResult(item, err))
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

// Move relocates each item into destDir, preferring the atomic rename and
// falling back to recursive copy+delete on EXDEV (crossing a filesystem
// boundary — e.g. /code's bind mount vs. the image's own overlay
// filesystem, see filemanager-plan.md's "원자적 이동" section). An item
// already in destDir is left where it is.
func Move(root string, items []string, destDir string, overwrite bool) []ItemResult {
	resolvedDest, failed := resolveDestDir(root, items, destDir)
	if failed != nil {
		return failed
	}

	results := make([]ItemResult, 0, len(items))
	for _, item := range items {
		results = append(results, itemResult(item, moveItem(root, item, resolvedDest, overwrite)))
	}
	return results
}

func moveItem(root, item, resolvedDest string, overwrite bool) error {
	resolvedSrc, err := ResolveNonRoot(root, item)
	if err != nil {
		return err
	}
	// ResolveForAccess (not the lexical ResolvePath) so an existing
	// destination entry that is a symlink out of the root is rejected
	// rather than written through by the EXDEV copy fallback.
	dest, err := ResolveForAccess(root, filepath.Join(resolvedDest, filepath.Base(resolvedSrc)))
	if err != nil {
		return err
	}
	if dest == resolvedSrc {
		return nil
	}
	if within(resolvedSrc, dest) {
		return ErrIntoItself
	}
	err = rename(resolvedSrc, dest, overwrite)
	var linkErr *os.LinkError
	if err == nil || !errors.As(err, &linkErr) || linkErr.Err != syscall.EXDEV {
		return err
	}
	if !overwrite {
		if _, err := os.Lstat(dest); err == nil {
			return ErrExists
		}
	}
	if err := copyPath(resolvedSrc, dest); err != nil {
		return err
	}
	return os.RemoveAll(resolvedSrc)
}

// Copy duplicates each item into destDir, recursively for directories. An
// item copied into its own directory gets a "name (copy)" name rather than
// being copied onto itself.
func Copy(root string, items []string, destDir string, overwrite bool) []ItemResult {
	resolvedDest, failed := resolveDestDir(root, items, destDir)
	if failed != nil {
		return failed
	}

	results := make([]ItemResult, 0, len(items))
	for _, item := range items {
		results = append(results, itemResult(item, copyItem(root, item, resolvedDest, overwrite)))
	}
	return results
}

func copyItem(root, item, resolvedDest string, overwrite bool) error {
	resolvedSrc, err := ResolveForAccess(root, item)
	if err != nil {
		return err
	}
	// Same as Move: resolve the destination's own final component so a
	// symlink already sitting there can't redirect the copy out of the
	// root.
	dest, err := ResolveForAccess(root, filepath.Join(resolvedDest, filepath.Base(resolvedSrc)))
	if err != nil {
		return err
	}
	if dest == resolvedSrc {
		// The copy dialog defaults to the current folder, so this is the
		// common case, not an edge case. Copying a file onto itself used to
		// truncate it before reading it.
		if dest, err = copyName(dest); err != nil {
			return err
		}
	} else if within(resolvedSrc, dest) {
		return ErrIntoItself
	} else if !overwrite {
		if _, err := os.Lstat(dest); err == nil {
			return ErrExists
		}
	}
	return copyPath(resolvedSrc, dest)
}

// copyName returns the first free "name (copy)", "name (copy 2)", ... next
// to path, keeping a file's extension at the end.
func copyName(path string) (string, error) {
	dir, base := filepath.Split(path)
	stem, ext := base, ""
	if info, err := os.Lstat(path); err == nil && !info.IsDir() {
		if e := filepath.Ext(base); e != "" && e != base {
			stem, ext = strings.TrimSuffix(base, e), e
		}
	}
	for n := 1; n < 1000; n++ {
		suffix := " (copy)"
		if n > 1 {
			suffix = fmt.Sprintf(" (copy %d)", n)
		}
		candidate := filepath.Join(dir, stem+suffix+ext)
		if _, err := os.Lstat(candidate); errors.Is(err, fs.ErrNotExist) {
			return candidate, nil
		}
	}
	return "", ErrExists
}

// copyPath recursively copies src to dest, preserving mode bits and
// re-creating symlinks as links (not following them into a copy of their
// target). Whatever is already at dest is replaced entry by entry; the
// caller has decided whether that is allowed.
func copyPath(src, dest string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}

	if info.IsDir() {
		// An existing directory is merged into. Anything else there - in
		// particular a symlink, which MkdirAll would follow and so carry the
		// copy wherever it points - is refused rather than written through.
		if existing, err := os.Lstat(dest); err == nil && !existing.IsDir() {
			return fmt.Errorf("%s: %w (and is not a directory)", dest, ErrExists)
		}
		if err := os.MkdirAll(dest, info.Mode().Perm()|0o700); err != nil {
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

	if existing, err := os.Lstat(dest); err == nil && existing.IsDir() {
		return fmt.Errorf("%s: %w (as a directory)", dest, ErrExists)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return replaceWith(dest, func(tmp string) error { return os.Symlink(target, tmp) })
	}
	return copyFile(src, dest, info.Mode())
}

// copyFile writes src's content to a temporary file next to dest and
// renames it over dest. Nothing at dest is touched until the copy is
// complete, so neither a failed copy nor a copy onto the source itself can
// destroy what was there. rename replaces a symlink at dest rather than
// following it, so a link deep in an existing destination tree (which had
// no check of its own) can't redirect the write.
func copyFile(src, dest string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	return writeReplacing(dest, mode, func(out *os.File) error {
		_, err := io.Copy(out, in)
		return err
	})
}

// writeReplacing creates a temporary file in dest's directory, fills it
// with write, gives it mode and renames it over dest. The temporary file is
// removed on any failure.
func writeReplacing(dest string, mode fs.FileMode, write func(*os.File) error) error {
	tmp, err := os.CreateTemp(filepath.Dir(dest), "."+filepath.Base(dest)+".partial-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if err := write(tmp); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Chmod(name, mode.Perm()); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, dest); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// replaceWith creates an entry at a free temporary name with create, then
// renames it over dest.
func replaceWith(dest string, create func(tmp string) error) error {
	for n := 0; n < 100; n++ {
		tmp := filepath.Join(filepath.Dir(dest), fmt.Sprintf(".%s.partial-%d-%d", filepath.Base(dest), os.Getpid(), n))
		err := create(tmp)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return err
		}
		if err := os.Rename(tmp, dest); err != nil {
			os.Remove(tmp)
			return err
		}
		return nil
	}
	return ErrExists
}
