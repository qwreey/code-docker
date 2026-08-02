package files

import (
	"os"
	"path/filepath"
)

// UploadResult is one multipart part's outcome, returned alongside its
// siblings so a partial failure doesn't fail the whole upload request (per
// CLAUDE.md's "부분 실패는 전체 요청 실패보다 열화" ground rule).
type UploadResult struct {
	Name  string `json:"name"`
	Ok    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
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

// OpenUploadDest validates dir + filename and opens (create/truncate) the
// destination file for writing. The handler is expected to io.Copy the
// multipart part's body into the returned file and close it.
func OpenUploadDest(root, dir, filename string) (destPath string, f *os.File, err error) {
	resolvedDir, err := ResolveForAccess(root, dir)
	if err != nil {
		return "", nil, err
	}
	info, err := os.Stat(resolvedDir)
	if err != nil {
		return "", nil, err
	}
	if !info.IsDir() {
		return "", nil, ErrNotDir
	}

	name, err := sanitizeUploadName(filename)
	if err != nil {
		return "", nil, err
	}

	dest := filepath.Join(resolvedDir, name)
	if _, err := ResolvePath(root, dest); err != nil {
		return "", nil, err
	}

	f, err = os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", nil, err
	}
	return dest, f, nil
}
