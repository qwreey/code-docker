package files

import (
	"os"
	"path/filepath"
)

// UploadResult is one multipart part's outcome, returned alongside its
// siblings so a partial failure doesn't fail the whole upload request (per
// CLAUDE.md's "부분 실패는 전체 요청 실패보다 열화" ground rule).
type UploadResult struct {
	Name   string `json:"name"`
	Ok     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Exists bool   `json:"exists,omitempty"`
}

// sanitizeUploadName reduces an untrusted multipart part filename to a bare
// basename, rejecting anything that would otherwise let a crafted filename
// (e.g. containing "../") escape the destination directory.
func sanitizeUploadName(filename string) (string, error) {
	base := filepath.Base(filepath.Clean(filename))
	if base == "" || base == "." || base == ".." || base == string(filepath.Separator) {
		return "", ErrInvalidName
	}
	return base, nil
}

// Upload is one file being received: the bytes go to a temporary file next
// to the destination, and only Commit puts it in place. A transfer that is
// cut off or over the size cap therefore leaves the file that was already
// there untouched.
type Upload struct {
	*os.File
	dest      string
	mode      os.FileMode
	overwrite bool
}

// StartUpload validates dir + filename and opens a temporary file to
// receive the upload. An existing destination is ErrExists unless
// overwrite is set; that is checked here, before any body is read, and
// again at Commit.
func StartUpload(root, dir, filename string, overwrite bool) (*Upload, error) {
	resolvedDir, err := ResolveForAccess(root, dir)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(resolvedDir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, ErrNotDir
	}

	name, err := sanitizeUploadName(filename)
	if err != nil {
		return nil, err
	}

	// ResolveForAccess, not the lexical ResolvePath: the destination may
	// already exist *as a symlink*. One that points out of the root is
	// refused; one that stays inside resolves to its target, which is what
	// gets replaced.
	dest, err := ResolveForAccess(root, filepath.Join(resolvedDir, name))
	if err != nil {
		return nil, err
	}
	mode := os.FileMode(0o644)
	if existing, err := os.Stat(dest); err == nil {
		if existing.IsDir() {
			return nil, ErrIsDir
		}
		if !overwrite {
			return nil, ErrExists
		}
		mode = existing.Mode().Perm()
	}

	f, err := os.CreateTemp(filepath.Dir(dest), "."+filepath.Base(dest)+".partial-*")
	if err != nil {
		return nil, err
	}
	return &Upload{File: f, dest: dest, mode: mode, overwrite: overwrite}, nil
}

// Commit closes the temporary file and moves it to the destination.
func (u *Upload) Commit() error {
	name := u.Name()
	if err := u.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Chmod(name, u.mode); err != nil {
		os.Remove(name)
		return err
	}
	if err := rename(name, u.dest, u.overwrite); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// Abort discards the temporary file; the destination was never touched.
func (u *Upload) Abort() {
	u.Close()
	os.Remove(u.Name())
}
