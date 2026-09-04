package webdavshare

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"

	"golang.org/x/net/webdav"

	filesjail "webmanager/internal/files"
)

// errEscapes is what every jailed operation returns when a name resolves
// outside the configured root. Mapped to 403 by webdav.Handler (it runs
// errors through its own status mapping, and os.ErrPermission is the one
// that lands there).
var errEscapes = os.ErrPermission

// jailedDir wraps webdav.Dir with internal/files' own path validation.
//
// webdav.Dir already refuses `..` traversal on its own (it path.Cleans a
// leading-slash name before joining), so this is not about that. What it
// adds is the *symlink* half: a symlink inside the root pointing outside it
// would otherwise be followed straight through, exactly the hole
// files.ResolveForAccess exists to close for the file manager (see
// filemanager-plan.md's "심볼릭 링크" section). Sharing that one function is
// the whole reason this share and the Files tab agree on what "inside the
// root" means.
//
// Like the file manager, this is a TOCTOU-shaped check (validate, then hand
// the path to the OS) rather than an openat2-style resolution. Same
// trade-off, same trust model: everything here already runs as root in a
// container whose terminal is a root shell.
type jailedDir struct {
	root string
	dir  webdav.Dir
}

func newJailedDir(root string) jailedDir {
	return jailedDir{root: root, dir: webdav.Dir(root)}
}

// abs maps a WebDAV name (slash-separated, relative to the share root) to
// the absolute filesystem path webdav.Dir would use for it.
func (j jailedDir) abs(name string) string {
	return filepath.Join(j.root, filepath.FromSlash(path.Clean("/"+name)))
}

// check validates name for content access (read or write *through* the
// path, so symlinks are resolved).
func (j jailedDir) check(name string) error {
	if _, err := filesjail.ResolveForAccess(j.root, j.abs(name)); err != nil {
		return errEscapes
	}
	return nil
}

// checkNonRoot is check plus a guard on the root itself, for the operations
// that would destroy or move the whole shared tree. Uses ResolveNonRoot
// (which does not follow symlinks) because these act on the directory entry
// rather than reading through it — the same split the file manager makes.
func (j jailedDir) checkNonRoot(name string) error {
	if _, err := filesjail.ResolveNonRoot(j.root, j.abs(name)); err != nil {
		if errors.Is(err, filesjail.ErrRootPath) {
			return errEscapes
		}
		return errEscapes
	}
	return nil
}

func (j jailedDir) Mkdir(ctx context.Context, name string, perm os.FileMode) error {
	if err := j.check(name); err != nil {
		return err
	}
	return j.dir.Mkdir(ctx, name, perm)
}

func (j jailedDir) OpenFile(ctx context.Context, name string, flag int, perm os.FileMode) (webdav.File, error) {
	if err := j.check(name); err != nil {
		return nil, err
	}
	return j.dir.OpenFile(ctx, name, flag, perm)
}

func (j jailedDir) RemoveAll(ctx context.Context, name string) error {
	if err := j.checkNonRoot(name); err != nil {
		return err
	}
	return j.dir.RemoveAll(ctx, name)
}

func (j jailedDir) Rename(ctx context.Context, oldName, newName string) error {
	if err := j.checkNonRoot(oldName); err != nil {
		return err
	}
	if err := j.check(newName); err != nil {
		return err
	}
	return j.dir.Rename(ctx, oldName, newName)
}

func (j jailedDir) Stat(ctx context.Context, name string) (fs.FileInfo, error) {
	if err := j.check(name); err != nil {
		return nil, err
	}
	return j.dir.Stat(ctx, name)
}
