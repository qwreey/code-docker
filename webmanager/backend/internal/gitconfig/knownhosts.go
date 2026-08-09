package gitconfig

import (
	"errors"
	"os"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"

	"webmanager/internal/atomicfile"
)

// knownHostsMu serializes read-modify-write access to path - see
// internal/sshkeys' identical mu for why.
var knownHostsMu sync.Mutex

// KnownHostEntry is one parsed line of ~/.ssh/known_hosts — a host key
// SSH has already trusted (distinct from SSHHost/~/.ssh/config's per-host
// identity blocks, and from the SSH-keys tab's ~/.ssh/authorized_keys).
type KnownHostEntry struct {
	Host        string `json:"host"`
	KeyType     string `json:"keyType"`
	Fingerprint string `json:"fingerprint"`
	Raw         string `json:"raw"`
}

var (
	ErrInvalidKnownHost  = errors.New("not a valid known_hosts entry")
	ErrKnownHostNotFound = errors.New("known_hosts entry not found")
)

// parseKnownHostLine parses a single known_hosts line: "<hosts> <keytype>
// <base64-key> [comment]", where <hosts> is either a comma-separated list of
// hostnames/patterns or a hashed "|1|salt|hash" marker (left as an opaque
// string — never unhashed). An optional leading "@cert-authority"/"@revoked"
// marker field is skipped. The key portion is handed to
// ssh.ParseAuthorizedKey, which understands "<keytype> <base64-key>
// [comment]" natively (it's the exact same shape authorized_keys uses minus
// the leading host field) — this reuses the same parsing/fingerprinting the
// SSH-keys tab already relies on (see internal/sshkeys) instead of
// hand-rolling base64/wire-format validation here.
func parseKnownHostLine(line string) (KnownHostEntry, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return KnownHostEntry{}, false
	}
	// strings.Fields below splits on any whitespace, including embedded
	// newlines - without this check, a caller-supplied multi-line string
	// would get flattened into one token stream (only the first line
	// meaningfully validated) while Raw (below) still preserved every
	// line, letting AddKnownHost smuggle an unvalidated second entry into
	// the file.
	if strings.ContainsAny(trimmed, "\n\r") {
		return KnownHostEntry{}, false
	}

	fields := strings.Fields(trimmed)
	if len(fields) > 0 && strings.HasPrefix(fields[0], "@") {
		fields = fields[1:]
	}
	if len(fields) < 3 {
		return KnownHostEntry{}, false
	}

	host := fields[0]
	rest := strings.Join(fields[1:], " ")
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(rest))
	if err != nil {
		return KnownHostEntry{}, false
	}

	return KnownHostEntry{
		Host:        host,
		KeyType:     pub.Type(),
		Fingerprint: ssh.FingerprintSHA256(pub),
		Raw:         trimmed,
	}, true
}

// ListKnownHosts parses path line by line. A missing file reads as an empty
// list rather than an error, matching the authorized_keys convention
// elsewhere in this codebase (see internal/sshkeys.List).
func ListKnownHosts(path string) ([]KnownHostEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []KnownHostEntry{}, nil
		}
		return nil, err
	}

	lines := strings.Split(string(data), "\n")
	entries := make([]KnownHostEntry, 0, len(lines))
	for _, line := range lines {
		if e, ok := parseKnownHostLine(line); ok {
			entries = append(entries, e)
		}
	}
	return entries, nil
}

// AddKnownHost validates line as a well-formed known_hosts entry (via the
// same parser ListKnownHosts uses) before appending it, so a malformed paste
// can't corrupt the file. Written with 0600 permissions, matching this
// codebase's other SSH file conventions (see internal/sshkeys.Add).
func AddKnownHost(path, line string) error {
	trimmed := strings.TrimSpace(line)
	if _, ok := parseKnownHostLine(trimmed); !ok {
		return ErrInvalidKnownHost
	}

	knownHostsMu.Lock()
	defer knownHostsMu.Unlock()

	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	content := string(data)
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += trimmed + "\n"
	return atomicfile.Write(path, []byte(content), 0o600, 0o700)
}

// DeleteKnownHost removes the entry at index into ListKnownHosts's result
// (i.e. the index-th successfully-parsed line, skipping blank/comment/
// unparsable lines — the same numbering a UI listing ListKnownHosts's output
// would show). An index is used rather than matching by raw line or
// fingerprint because known_hosts commonly contains legitimate duplicate
// host/key pairs (same key under differently-hashed or differently-cased
// hostname spellings); "delete row N" from the list the UI is currently
// showing is unambiguous, whereas matching by content is not. This is a
// tradeoff against concurrent edits (an index computed from a stale read can
// delete the wrong row if the file changed in between) but that's no worse
// than every other index/id-based list-then-mutate flow in this codebase.
func DeleteKnownHost(path string, index int) error {
	knownHostsMu.Lock()
	defer knownHostsMu.Unlock()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ErrKnownHostNotFound
		}
		return err
	}

	lines := strings.Split(string(data), "\n")
	kept := make([]string, 0, len(lines))
	found := false
	parsedIdx := 0
	for _, line := range lines {
		if _, ok := parseKnownHostLine(line); ok {
			if parsedIdx == index {
				found = true
				parsedIdx++
				continue
			}
			parsedIdx++
		}
		kept = append(kept, line)
	}
	if !found {
		return ErrKnownHostNotFound
	}

	content := strings.Join(kept, "\n")
	return atomicfile.Write(path, []byte(content), 0o600, 0o700)
}
