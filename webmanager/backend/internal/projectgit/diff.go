package projectgit

import (
	"errors"
	"regexp"
)

// ErrInvalidHash is returned by CommitDiff when hash doesn't look like a
// plausible git object id. Without this check, a value like "--output=..."
// passed as a bare trailing exec.Command arg could be misparsed by git as a
// flag instead of a literal revision — same class of issue as
// internal/gitconfig's fingerprint validation and internal/dind's ID
// validation.
var ErrInvalidHash = errors.New("hash must be a hex git object id")

// hashRe accepts anything from a short abbreviated hash up to a full 40-hex
// SHA-1 (git's abbreviations are usually 7-12 chars, but any length in
// between is valid input from a real `git log` result).
var hashRe = regexp.MustCompile(`^[0-9a-fA-F]{4,40}$`)

// ValidateHash reports whether hash is safe to pass as a trailing
// exec.Command argument to git.
func ValidateHash(hash string) error {
	if !hashRe.MatchString(hash) {
		return ErrInvalidHash
	}
	return nil
}

// Diff is a diff view's text, cut at maxDiffBytes (on a line boundary)
// when Truncated.
type Diff struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

// CommitDiff returns `git show`'s raw output (commit metadata + unified
// diff) for one commit. hash must pass ValidateHash first.
func CommitDiff(path, hash string) (Diff, error) {
	if err := ValidateHash(hash); err != nil {
		return Diff{}, err
	}
	return runDiff(path, "show", hash)
}

// UnstagedDiff returns `git diff`'s raw unified-diff text: worktree changes
// not yet staged. Empty text (no error) when there's nothing to show.
func UnstagedDiff(path string) (Diff, error) {
	return runDiff(path, "diff")
}

// StagedDiff returns `git diff --cached`'s raw unified-diff text: changes
// staged for the next commit. Empty text (no error) when there's nothing
// to show.
func StagedDiff(path string) (Diff, error) {
	return runDiff(path, "diff", "--cached")
}

func runDiff(path, subcommand string, rest ...string) (Diff, error) {
	if !IsGitRepo(path) {
		return Diff{}, ErrNotGitRepo
	}
	args := append(append([]string{subcommand}, gitReadDiffFlags...), rest...)
	out, truncated, err := gitCall{path: path, args: args, maxOut: maxDiffBytes, truncate: true}.run()
	if err != nil {
		return Diff{}, err
	}
	return Diff{Text: string(out), Truncated: truncated}, nil
}
