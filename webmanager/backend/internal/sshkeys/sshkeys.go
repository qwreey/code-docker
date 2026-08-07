// Package sshkeys manages an authorized_keys file: parsing entries,
// appending new ones, and removing them by a stable derived id.
//
// The file is modeled as an ordered list of Entry values. Most lines are Key
// entries (a parseable public key), but a standalone line starting with "#"
// is also a first-class Entry (Kind Comment) — people use these as
// freeform section markers/notes ("keys below are for X"), so they're
// listed, editable, deletable, and reorderable exactly like keys. Blank
// lines are the only thing still treated as pure formatting: they're never
// modeled as an entry (nothing to show/edit/drag for an empty line).
package sshkeys

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
)

type Key struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Comment     string `json:"comment"`
	Fingerprint string `json:"fingerprint"`
	Raw         string `json:"raw"`
}

type EntryKind string

const (
	KindKey     EntryKind = "key"
	KindComment EntryKind = "comment"
)

// Entry is the unit List/Reorder operate on — either a Key or a standalone
// "# ..." comment line, in original file order. Exactly one of Key/Text is
// set, matching Kind.
type Entry struct {
	ID   string    `json:"id"`
	Kind EntryKind `json:"kind"`
	Key  *Key      `json:"key,omitempty"`
	Text string    `json:"text,omitempty"`
}

var (
	ErrInvalidKey     = errors.New("not a valid ssh public key")
	ErrInvalidComment = errors.New("not a valid comment line")
	ErrDuplicate      = errors.New("key already exists")
	ErrNotFound       = errors.New("key not found")
	ErrOrderMismatch  = errors.New("order does not match current entries")
)

// id is derived from the key material only (not the comment/options), so
// re-adding the same key with a different comment is still a duplicate.
func computeID(pub ssh.PublicKey) string {
	sum := sha256.Sum256(pub.Marshal())
	return hex.EncodeToString(sum[:])
}

// Comment entries have no unique content to hash on its own — the same
// marker text ("# --- personal ---") may appear more than once in a file —
// so the id also folds in the line's index. This means a comment's id is
// only stable until the *next* mutation (any add/update/delete/reorder can
// shift indices); callers must always use the id from the most recent List
// response, never one cached across a mutation.
func computeCommentID(index int, text string) string {
	sum := sha256.Sum256([]byte(strconv.Itoa(index) + ":" + text))
	return hex.EncodeToString(sum[:])
}

func parseLine(line string) (Key, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return Key{}, false
	}
	// ssh.ParseAuthorizedKey only validates its FIRST line and silently
	// succeeds with the rest discarded - without this check, a caller-
	// supplied multi-line string would pass validation on line one while
	// Raw (below) still captured every line, letting Add/Update smuggle
	// unreviewed extra authorized_keys entries into the file.
	if strings.ContainsAny(trimmed, "\n\r") {
		return Key{}, false
	}
	pub, comment, _, _, err := ssh.ParseAuthorizedKey([]byte(trimmed))
	if err != nil {
		return Key{}, false
	}
	return Key{
		ID:          computeID(pub),
		Type:        pub.Type(),
		Comment:     comment,
		Fingerprint: ssh.FingerprintSHA256(pub),
		Raw:         trimmed,
	}, true
}

// parseEntry classifies one raw line (at its 0-based index in the file) as a
// Key entry, a Comment entry, or nothing (blank line, or a line that's
// neither a valid key nor a "#" comment — malformed leftovers are ignored
// rather than surfaced, same as before this Entry model existed).
func parseEntry(index int, line string) (Entry, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return Entry{}, false
	}
	if strings.HasPrefix(trimmed, "#") {
		return Entry{ID: computeCommentID(index, trimmed), Kind: KindComment, Text: trimmed}, true
	}
	k, ok := parseLine(line)
	if !ok {
		return Entry{}, false
	}
	return Entry{ID: k.ID, Kind: KindKey, Key: &k}, true
}

// List returns every key/comment entry in the file, in file order.
func List(path string) ([]Entry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []Entry{}, nil
		}
		return nil, err
	}
	lines := strings.Split(string(data), "\n")
	entries := make([]Entry, 0, len(lines))
	for i, line := range lines {
		if e, ok := parseEntry(i, line); ok {
			entries = append(entries, e)
		}
	}
	return entries, nil
}

// ListKeys is List filtered down to Key entries — used internally for
// duplicate-key checks, which don't care about comment entries at all.
func ListKeys(path string) ([]Key, error) {
	entries, err := List(path)
	if err != nil {
		return nil, err
	}
	keys := make([]Key, 0, len(entries))
	for _, e := range entries {
		if e.Kind == KindKey {
			keys = append(keys, *e.Key)
		}
	}
	return keys, nil
}

func appendLine(path, line string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteString(line + "\n"); err != nil {
		return err
	}
	return f.Chmod(0o600)
}

func Add(path, keyLine string) (Key, error) {
	k, ok := parseLine(keyLine)
	if !ok {
		return Key{}, ErrInvalidKey
	}

	existing, err := ListKeys(path)
	if err != nil {
		return Key{}, err
	}
	for _, e := range existing {
		if e.ID == k.ID {
			return Key{}, ErrDuplicate
		}
	}

	if err := appendLine(path, k.Raw); err != nil {
		return Key{}, err
	}
	return k, nil
}

// AddComment appends a new standalone "# ..." line (a "#" prefix is added
// automatically if the caller didn't include one). The appended entry's id
// is read back via List since it depends on the line's final index in the
// file.
func AddComment(path, text string) (Entry, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || strings.ContainsAny(trimmed, "\n\r") {
		return Entry{}, ErrInvalidComment
	}
	if !strings.HasPrefix(trimmed, "#") {
		trimmed = "# " + trimmed
	}

	if err := appendLine(path, trimmed); err != nil {
		return Entry{}, err
	}

	entries, err := List(path)
	if err != nil {
		return Entry{}, err
	}
	if len(entries) == 0 {
		return Entry{}, errors.New("comment was appended but is missing from the file")
	}
	return entries[len(entries)-1], nil
}

// Update rewrites the file line-by-line, replacing only the exact line
// whose parsed id matches with the (re-parsed and validated) newKeyLine.
// Every other line — including comment/blank lines — is preserved verbatim,
// same principle as Delete. Since id is derived from the key material,
// changing the key itself (not just its comment) means the returned
// Key.ID legitimately differs from the id argument; callers should treat
// the returned Key as authoritative.
func Update(path, id, newKeyLine string) (Key, error) {
	newKey, ok := parseLine(newKeyLine)
	if !ok {
		return Key{}, ErrInvalidKey
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Key{}, ErrNotFound
		}
		return Key{}, err
	}

	lines := strings.Split(string(data), "\n")
	found := false
	for i, line := range lines {
		k, ok := parseLine(line)
		if !ok {
			continue
		}
		if k.ID == id {
			found = true
			lines[i] = newKey.Raw
			continue
		}
		if k.ID == newKey.ID {
			return Key{}, ErrDuplicate
		}
	}
	if !found {
		return Key{}, ErrNotFound
	}

	content := strings.Join(lines, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return Key{}, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return Key{}, err
	}
	return newKey, nil
}

// UpdateComment rewrites the exact line whose current (index-derived) id
// matches, replacing its text. Every other line is preserved verbatim. The
// replacement happens in place at the same line index, so the returned
// entry's id (also index-derived) can be computed directly without a
// re-read.
func UpdateComment(path, id, newText string) (Entry, error) {
	trimmed := strings.TrimSpace(newText)
	if trimmed == "" || strings.ContainsAny(trimmed, "\n\r") {
		return Entry{}, ErrInvalidComment
	}
	if !strings.HasPrefix(trimmed, "#") {
		trimmed = "# " + trimmed
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Entry{}, ErrNotFound
		}
		return Entry{}, err
	}

	lines := strings.Split(string(data), "\n")
	foundIndex := -1
	for i, line := range lines {
		e, ok := parseEntry(i, line)
		if !ok || e.Kind != KindComment {
			continue
		}
		if e.ID == id {
			foundIndex = i
			break
		}
	}
	if foundIndex == -1 {
		return Entry{}, ErrNotFound
	}
	lines[foundIndex] = trimmed

	content := strings.Join(lines, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return Entry{}, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return Entry{}, err
	}

	return Entry{ID: computeCommentID(foundIndex, trimmed), Kind: KindComment, Text: trimmed}, nil
}

// Reorder rewrites the whole file from scratch, one line per entry, in the
// exact order given by orderedIDs (which must name every current key AND
// comment entry, each exactly once — ErrOrderMismatch otherwise, to rule
// out accidental data loss from a stale/tampered client-side list). Unlike
// the old key-only slot-preserving approach, this regenerates the entire
// file purely from entries: any blank line that previously sat between
// entries is not reproduced (comments are now user-owned, moveable content
// rather than fixed background, so there's no fixed set of "gap" positions
// left to preserve them in). Add/Update/Delete are unaffected by this and
// still touch only the one line they target.
func Reorder(path string, orderedIDs []string) ([]Entry, error) {
	entries, err := List(path)
	if err != nil {
		return nil, err
	}

	if len(orderedIDs) != len(entries) {
		return nil, ErrOrderMismatch
	}
	byID := make(map[string]Entry, len(entries))
	for _, e := range entries {
		byID[e.ID] = e
	}

	seen := make(map[string]bool, len(orderedIDs))
	lines := make([]string, 0, len(orderedIDs))
	for _, id := range orderedIDs {
		if seen[id] {
			return nil, ErrOrderMismatch
		}
		e, ok := byID[id]
		if !ok {
			return nil, ErrOrderMismatch
		}
		seen[id] = true
		if e.Kind == KindKey {
			lines = append(lines, e.Key.Raw)
		} else {
			lines = append(lines, e.Text)
		}
	}

	if len(lines) == 0 {
		return []Entry{}, nil
	}

	content := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, err
	}

	return List(path)
}

// Delete rewrites the file line-by-line, dropping only the line whose
// parsed id matches. Non-key lines (comments, blank lines, entries that
// fail to parse) are preserved verbatim.
func Delete(path, id string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}

	lines := strings.Split(string(data), "\n")
	kept := make([]string, 0, len(lines))
	found := false
	for _, line := range lines {
		if k, ok := parseLine(line); ok && k.ID == id {
			found = true
			continue
		}
		kept = append(kept, line)
	}
	if !found {
		return ErrNotFound
	}

	content := strings.Join(kept, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// DeleteComment rewrites the file line-by-line, dropping only the comment
// line whose current (index-derived) id matches. Every other line —
// including other comments and all key lines — is preserved verbatim.
func DeleteComment(path, id string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}

	lines := strings.Split(string(data), "\n")
	kept := make([]string, 0, len(lines))
	found := false
	for i, line := range lines {
		if e, ok := parseEntry(i, line); ok && e.Kind == KindComment && e.ID == id {
			found = true
			continue
		}
		kept = append(kept, line)
	}
	if !found {
		return ErrNotFound
	}

	content := strings.Join(kept, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
