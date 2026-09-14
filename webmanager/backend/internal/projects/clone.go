package projects

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	// ErrUnknownRoot is returned when a caller-supplied root doesn't exactly
	// match one of the Scanner's configured paths — same exact-match
	// convention as IsKnownPath, applied to roots instead of full project
	// paths (a fresh clone has no cached project entry yet to match against).
	ErrUnknownRoot = errors.New("unknown project root")
	// ErrInvalidCloneName is returned by ValidateCloneName when name isn't a
	// safe, single-segment destination folder name.
	ErrInvalidCloneName = errors.New("name must be a single path segment (letters, numbers, dot, underscore, dash, starting with a letter or number)")
	// ErrCloneDestExists is returned when the resolved destination already
	// exists on disk.
	ErrCloneDestExists = errors.New("destination already exists")
	// ErrInvalidBranchName is returned by ValidateBranchName when branch
	// isn't a safe git ref name.
	ErrInvalidBranchName = errors.New("branch must be a valid git ref name (letters, numbers, dot, underscore, dash, slash, starting with a letter or number)")
	// ErrInvalidCloneURL is returned by ValidateCloneURL for anything that
	// isn't one of the four network transports or the scp-style form.
	ErrInvalidCloneURL = errors.New("url must be http://, https://, git://, ssh:// or scp-style user@host:path")
)

// allowedCloneSchemes is the same set passed to git as GIT_ALLOW_PROTOCOL
// (see handlers_projects.go's handleCloneProject). Everything else git
// understands here is either a local-filesystem read (`file://`, a bare
// path) or a *command execution* transport (`ext::`, `fd::`, and any other
// `<helper>::<address>` remote helper — `ext::sh -c id` runs a shell, since
// git's own protocol.ext.allow defaults to "user").
var allowedCloneSchemes = map[string]bool{
	"http":  true,
	"https": true,
	"git":   true,
	"ssh":   true,
}

// scpHostRe matches the host part of the scp-style `[user@]host:path`
// form — a hostname or IPv4 literal, nothing else. No brackets (a
// bracketed IPv6 literal contains "::", which is rejected outright as a
// remote-helper marker; ssh://[::1]/repo is the supported spelling for
// that).
var scpHostRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$`)

// ValidateCloneURL restricts a clone URL to the transports that actually
// talk to a remote over the network. Argument injection is already handled
// by the "--" separator in handleCloneProject; this is about git's *own*
// URL vocabulary, where `ext::sh -c 'id'` is a documented way to spell
// "run this command" and `file:///` or a bare path is a way to read the
// container's filesystem through a route that isn't the file manager's
// jail.
//
// Accepted:
//   - http://, https://, git://, ssh:// (case-insensitive scheme)
//   - scp-style [user@]host:path
//
// Rejected: every other scheme, any `<helper>::<address>` remote helper, a
// leading "-" (never mistakable for a flag even without "--"), whitespace
// and control characters, and bare/relative local paths.
func ValidateCloneURL(raw string) error {
	if raw == "" || strings.HasPrefix(raw, "-") {
		return ErrInvalidCloneURL
	}
	for _, r := range raw {
		if r <= ' ' || r == 0x7f {
			return ErrInvalidCloneURL
		}
	}

	if i := strings.Index(raw, "://"); i > 0 {
		if !allowedCloneSchemes[strings.ToLower(raw[:i])] {
			return ErrInvalidCloneURL
		}
		if strings.TrimSpace(raw[i+3:]) == "" {
			return ErrInvalidCloneURL
		}
		return nil
	}

	// No scheme: only the scp-style form is left. "::" anywhere here means
	// a remote helper (`ext::`, `fd::`, `transport::address`).
	if strings.Contains(raw, "::") {
		return ErrInvalidCloneURL
	}
	colon := strings.Index(raw, ":")
	if colon <= 0 || colon == len(raw)-1 {
		return ErrInvalidCloneURL
	}
	// A "/" before the first ":" means this is a path, not host:path —
	// git treats it as a local repository.
	if slash := strings.Index(raw, "/"); slash >= 0 && slash < colon {
		return ErrInvalidCloneURL
	}
	host := raw[:colon]
	if at := strings.LastIndex(host, "@"); at >= 0 {
		if at == 0 || at == len(host)-1 {
			return ErrInvalidCloneURL
		}
		host = host[at+1:]
	}
	if !scpHostRe.MatchString(host) {
		return ErrInvalidCloneURL
	}
	return nil
}

// cloneNameRe mirrors mise.toolIDRe/versionRe's convention (a leading `-`
// could otherwise be misparsed as a flag) but is stricter: no `/` at all, so
// a caller-supplied name can never escape the chosen root via a path
// separator, mirroring the "exact-match against a known-good set" validation
// every other project-mutation method in this file uses — here there's
// nothing to match against yet (the destination doesn't exist), so a strict
// charset allowlist is the closest equivalent.
var cloneNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// ValidateCloneName reports whether name is safe to use as a single new
// subdirectory name directly under an already-known root.
func ValidateCloneName(name string) error {
	if !cloneNameRe.MatchString(name) || name == "." || name == ".." {
		return ErrInvalidCloneName
	}
	return nil
}

// branchNameRe allows the charset git ref names actually use (letters,
// numbers, dot, underscore, dash, slash for namespaced branches like
// "feature/x") while still rejecting a leading "-" (so it can never look
// like a flag) and anything outside that allowlist (spaces, control chars,
// "~^:?*[\"). This is intentionally passed to `git clone` as its own
// exec.Command argument (the value of -b) rather than string-concatenated,
// same defense-in-depth convention as ValidateCloneName/PrepareClone's dest
// path and internal/projectgit.RemoveWorktree's worktree path — this
// allowlist is a second, independent layer on top of that.
var branchNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)

// ValidateBranchName reports whether name is safe to pass as `git clone
// -b <name>`. Empty is not validated here — an empty branch means "use the
// remote's default branch" and callers should skip validation/the -b flag
// entirely in that case.
func ValidateBranchName(name string) error {
	if !branchNameRe.MatchString(name) ||
		strings.Contains(name, "..") || strings.Contains(name, "//") || strings.Contains(name, "@{") ||
		strings.HasSuffix(name, "/") || strings.HasSuffix(name, ".") || strings.HasSuffix(name, ".lock") {
		return ErrInvalidBranchName
	}
	return nil
}

// IsKnownRoot reports whether root exactly matches one of the Scanner's
// configured scan roots — never a prefix/contains check, same convention as
// IsKnownPath.
func (s *Scanner) IsKnownRoot(root string) bool {
	for _, p := range s.paths {
		if p == root {
			return true
		}
	}
	return false
}

// DefaultRoot returns the first configured scan root, for callers (the
// clone dialog) that don't need to ask the user to pick one when only a
// single root is configured. ok is false if no root is configured at all.
func (s *Scanner) DefaultRoot() (string, bool) {
	if len(s.paths) == 0 {
		return "", false
	}
	return s.paths[0], true
}

// PrepareClone validates root and name and returns the destination path a
// `git clone` should target. root must exactly match a configured scan root
// (ErrUnknownRoot) and name must pass ValidateCloneName. The resolved
// destination must not already exist (ErrCloneDestExists) — git itself
// refuses to clone into a non-empty directory, but checking here up front
// gives a clearer error than parsing git's own stderr for it, and the
// filepath.Dir check below defends against name resolving outside root even
// though cloneNameRe already rejects any `/`.
func (s *Scanner) PrepareClone(root, name string) (string, error) {
	if !s.IsKnownRoot(root) {
		return "", ErrUnknownRoot
	}
	if err := ValidateCloneName(name); err != nil {
		return "", err
	}

	dest := filepath.Join(root, name)
	if filepath.Dir(dest) != root {
		return "", ErrInvalidCloneName
	}

	if _, err := os.Stat(dest); err == nil {
		return "", ErrCloneDestExists
	} else if !os.IsNotExist(err) {
		return "", err
	}

	return dest, nil
}
