package files

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

const (
	// textDetectSampleSize mirrors the http.DetectContentType convention
	// of sniffing the first 512 bytes.
	textDetectSampleSize = 512
	// maxTextFileBytes is an upper bound on what's reasonable to load into
	// LazyCodeEditor at once, and so also on what it saves.
	maxTextFileBytes = 5 * 1024 * 1024
	// MaxTextSaveBodyBytes is the request body cap for saving a text file:
	// the content as a JSON string, whose escaping (quotes, backslashes,
	// control characters) adds to its size, plus the path.
	MaxTextSaveBodyBytes = 2*maxTextFileBytes + 64*1024
)

var (
	// ErrBinaryFile is returned by ReadTextContent when the sampled bytes
	// look binary (contain a NUL byte).
	ErrBinaryFile = errors.New("files: file appears to be binary")
	// ErrFileTooLarge is returned by ReadTextContent when the file exceeds
	// maxTextFileBytes.
	ErrFileTooLarge = errors.New("files: file too large to view as text")
	// ErrNotUTF8 is returned by ReadTextContent for text in another
	// encoding (CP949, Latin-1, ...). The editor works on a JSON string, and
	// encoding the bytes as one turns every invalid sequence into U+FFFD, so
	// saving after a one-character edit would rewrite all of them.
	ErrNotUTF8 = errors.New("files: not UTF-8 text")
	// ErrChanged is returned by WriteTextContent when the file is no longer
	// the version the editor loaded: something else (an agent, a terminal)
	// wrote it in between, and saving would silently discard that.
	ErrChanged = errors.New("files: file changed on disk since it was opened")
)

// TextVersion identifies a file's content for WriteTextContent's
// changed-since-opened check.
func TextVersion(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:16])
}

// ReadTextContent reads path's full content for the editor, first rejecting
// it (rather than truncating) if it looks binary or is too large — see
// filemanager-plan.md's "텍스트 판별" section. truncated is always false in
// the current implementation (oversized files are rejected outright, not
// truncated); the field is kept for API-shape stability in case a future
// revision truncates instead. version is TextVersion of what was read.
func ReadTextContent(root, userPath string) (content string, truncated bool, version string, err error) {
	resolved, err := ResolveForAccess(root, userPath)
	if err != nil {
		return "", false, "", err
	}

	info, err := os.Stat(resolved)
	if err != nil {
		return "", false, "", err
	}
	if info.IsDir() {
		return "", false, "", ErrIsDir
	}

	f, err := os.Open(resolved)
	if err != nil {
		return "", false, "", err
	}
	defer f.Close()

	sample := make([]byte, textDetectSampleSize)
	n, rerr := f.Read(sample)
	if rerr != nil && rerr != io.EOF {
		return "", false, "", rerr
	}
	if bytes.IndexByte(sample[:n], 0) != -1 {
		return "", false, "", ErrBinaryFile
	}

	if info.Size() > maxTextFileBytes {
		return "", false, "", ErrFileTooLarge
	}

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", false, "", err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return "", false, "", err
	}
	if !utf8.Valid(data) {
		return "", false, "", ErrNotUTF8
	}
	return string(data), false, TextVersion(data), nil
}

// WriteTextContent atomically replaces path's content: writes to a temp
// file in the same directory, then os.Rename over the original (per
// filemanager-plan.md's "PUT /api/files/content" section) so a crash
// mid-write never leaves a truncated file behind. Creates a new file if one
// doesn't already exist.
//
// baseVersion is the version ReadTextContent returned when the editor
// opened the file; if the file now has different content (or is gone), the
// write is refused with ErrChanged. An empty baseVersion writes
// unconditionally - a new file, or the user chose to overwrite.
func WriteTextContent(root, userPath, content, baseVersion string) (version string, err error) {
	if len(content) > maxTextFileBytes {
		return "", ErrFileTooLarge
	}
	resolved, err := ResolveForAccess(root, userPath)
	if err != nil {
		return "", err
	}

	existing, statErr := os.Stat(resolved)
	if statErr == nil && existing.IsDir() {
		return "", ErrIsDir
	}
	if baseVersion != "" {
		current, err := os.ReadFile(resolved)
		if err != nil || TextVersion(current) != baseVersion {
			return "", ErrChanged
		}
	}

	dir := filepath.Dir(resolved)
	tmp, err := os.CreateTemp(dir, ".files-write-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below succeeds

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}

	mode := os.FileMode(0o644)
	if statErr == nil {
		mode = existing.Mode()
	}
	_ = os.Chmod(tmpPath, mode)

	if err := os.Rename(tmpPath, resolved); err != nil {
		return "", err
	}
	return TextVersion([]byte(content)), nil
}
