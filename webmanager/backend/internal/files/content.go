package files

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const (
	// textDetectSampleSize mirrors the http.DetectContentType convention
	// of sniffing the first 512 bytes.
	textDetectSampleSize = 512
	// maxTextFileBytes is an upper bound on what's reasonable to load into
	// LazyCodeEditor at once.
	maxTextFileBytes = 5 * 1024 * 1024
)

var (
	// ErrBinaryFile is returned by ReadTextContent when the sampled bytes
	// look binary (contain a NUL byte).
	ErrBinaryFile = errors.New("files: file appears to be binary")
	// ErrFileTooLarge is returned by ReadTextContent when the file exceeds
	// maxTextFileBytes.
	ErrFileTooLarge = errors.New("files: file too large to view as text")
)

// ReadTextContent reads path's full content for the editor, first rejecting
// it (rather than truncating) if it looks binary or is too large — see
// filemanager-plan.md's "텍스트 판별" section. truncated is always false in
// the current implementation (oversized files are rejected outright, not
// truncated); the field is kept for API-shape stability in case a future
// revision truncates instead.
func ReadTextContent(root, userPath string) (content string, truncated bool, err error) {
	resolved, err := ResolveForAccess(root, userPath)
	if err != nil {
		return "", false, err
	}

	info, err := os.Stat(resolved)
	if err != nil {
		return "", false, err
	}
	if info.IsDir() {
		return "", false, ErrIsDir
	}

	f, err := os.Open(resolved)
	if err != nil {
		return "", false, err
	}
	defer f.Close()

	sample := make([]byte, textDetectSampleSize)
	n, rerr := f.Read(sample)
	if rerr != nil && rerr != io.EOF {
		return "", false, rerr
	}
	if bytes.IndexByte(sample[:n], 0) != -1 {
		return "", false, ErrBinaryFile
	}

	if info.Size() > maxTextFileBytes {
		return "", false, ErrFileTooLarge
	}

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", false, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return "", false, err
	}
	return string(data), false, nil
}

// WriteTextContent atomically replaces path's content: writes to a temp
// file in the same directory, then os.Rename over the original (per
// filemanager-plan.md's "PUT /api/files/content" section) so a crash
// mid-write never leaves a truncated file behind. Creates a new file if one
// doesn't already exist.
func WriteTextContent(root, userPath, content string) error {
	resolved, err := ResolveForAccess(root, userPath)
	if err != nil {
		return err
	}

	existing, statErr := os.Stat(resolved)
	if statErr == nil && existing.IsDir() {
		return ErrIsDir
	}

	dir := filepath.Dir(resolved)
	tmp, err := os.CreateTemp(dir, ".files-write-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below succeeds

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	mode := os.FileMode(0o644)
	if statErr == nil {
		mode = existing.Mode()
	}
	_ = os.Chmod(tmpPath, mode)

	return os.Rename(tmpPath, resolved)
}
