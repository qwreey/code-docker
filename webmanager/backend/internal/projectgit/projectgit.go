// Package projectgit shells out to `git` to report read-only status/history
// for one already-validated project directory (see the Projects tab).
// Nothing here ever mutates a repo — no add/commit/push/pull/merge, staging
// or checkout — that's explicitly deferred to a future milestone. Every
// exported function takes a plain filesystem path; callers (handlers_
// projectgit.go) are responsible for validating that path against
// internal/projects.Scanner's cached project list (exact match, never
// prefix/contains) before it ever reaches here — same convention as
// internal/projects's own DeleteReclaimable/DeleteProject, see that
// package's doc comments.
//
// The `git status --porcelain=v1 -b` parsing below intentionally mirrors
// this machine's own fish-shell prompt helper
// (~/.config/fish/functions/quiteline-fish/_qtm_git_info.fish) line for
// line, rather than inventing a new classification scheme.
package projectgit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// gitTimeout bounds every git invocation in this package. These are all
// local, fast operations (status/log/diff/remote/branch/tag reads on an
// already-checked-out repo) — a few seconds is generous, not a real budget.
const gitTimeout = 5 * time.Second

// ErrNotGitRepo is returned by every function here except IsGitRepo/Status
// (which report "not a repo" as a value, not an error — see each's doc
// comment) when path isn't a git working tree.
var ErrNotGitRepo = errors.New("not a git repository")

// runGit runs `git -C <path> <args...>` with gitTimeout, returning stdout on
// success. On failure the error message is git's own stderr (trimmed), not
// the opaque *exec.ExitError, so callers/logs get something actionable.
func runGit(path string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()

	full := append([]string{"-C", path}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.Bytes(), fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.Bytes(), nil
}

// IsGitRepo reports whether path is (the top of, or inside) a git working
// tree. Any error (git not installed, path doesn't exist, not a repo) is
// treated as "not a repo" rather than surfaced — callers that need to
// distinguish those cases don't exist yet in this app.
func IsGitRepo(path string) bool {
	out, err := runGit(path, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "true"
}

// RepoStatus is the parsed result of `git status --porcelain=v1 -b`, plus a
// stash count from a separate cheap call. Field order/semantics mirror
// _qtm_git_info.fish's own output tuple. When IsGitRepo is false every other
// field is its zero value — callers should check IsGitRepo first, not infer
// "not a repo" from e.g. an empty Branch.
type RepoStatus struct {
	IsGitRepo bool   `json:"isGitRepo"`
	Branch    string `json:"branch"`
	Staged    int    `json:"staged"`
	Changed   int    `json:"changed"`
	Untracked int    `json:"untracked"`
	Behind    int    `json:"behind"`
	Ahead     int    `json:"ahead"`
	Diverged  int    `json:"diverged"`
	Stashed   int    `json:"stashed"`
	Conflicts int    `json:"conflicts"`
	Clean     bool   `json:"clean"`
}

// Status runs and parses `git status --porcelain=v1 -b` for path. Returns
// RepoStatus{IsGitRepo: false}, nil (not an error) when path isn't a git
// repo — per this app's "degrade gracefully" convention, so the frontend can
// just hide the git panel instead of handling an error response.
func Status(path string) (RepoStatus, error) {
	if !IsGitRepo(path) {
		return RepoStatus{IsGitRepo: false}, nil
	}

	out, err := runGit(path, "status", "--porcelain=v1", "-b")
	if err != nil {
		return RepoStatus{}, err
	}

	st := RepoStatus{IsGitRepo: true}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) > 0 {
		branch, ahead, behind, diverged := parseBranchLine(lines[0])
		st.Branch = branch
		st.Ahead = ahead
		st.Behind = behind
		st.Diverged = diverged
		lines = lines[1:]
	}
	if st.Branch == "" {
		// Detached HEAD ("## HEAD (no branch)") or a malformed/missing
		// header line — resolve a display name the same way
		// _qtm_git_info.fish falls back: an exact tag match, else a
		// "@"-prefixed short hash.
		st.Branch = resolveDetachedBranch(path)
	}

	for _, line := range lines {
		if line == "" || strings.HasPrefix(line, "##") || strings.HasPrefix(line, "!!") {
			continue
		}
		conflict, untracked, staged, changed := classifyStatusLine(line)
		if conflict {
			st.Conflicts++
		}
		if untracked {
			st.Untracked++
		}
		if staged {
			st.Staged++
		}
		if changed {
			st.Changed++
		}
	}

	st.Stashed = stashCount(path)
	st.Clean = st.Staged == 0 && st.Changed == 0 && st.Untracked == 0 &&
		st.Behind == 0 && st.Ahead == 0 && st.Diverged == 0 &&
		st.Stashed == 0 && st.Conflicts == 0

	return st, nil
}

// resolveDetachedBranch mirrors _qtm_git_info.fish's fallback chain for when
// there's no current branch name: an exact tag match on HEAD, else a
// "@"-prefixed short commit hash. Both sub-calls are best-effort — any
// failure (e.g. brand new repo with no commits yet) just yields "".
func resolveDetachedBranch(path string) string {
	if out, err := runGit(path, "describe", "--tags", "--exact-match", "HEAD"); err == nil {
		if tag := strings.TrimSpace(string(out)); tag != "" {
			return tag
		}
	}
	if out, err := runGit(path, "rev-parse", "--short", "HEAD"); err == nil {
		if hash := strings.TrimSpace(string(out)); hash != "" {
			return "@" + hash
		}
	}
	return ""
}

// stashCount runs `git rev-list --walk-reflogs --count refs/stash`. A
// non-zero exit just means no stash ref exists yet (no stash was ever
// created in this repo) — that's 0, not an error, per this package's doc
// comment.
func stashCount(path string) int {
	out, err := runGit(path, "rev-list", "--walk-reflogs", "--count", "refs/stash")
	if err != nil {
		return 0
	}
	n := 0
	fmt.Sscanf(strings.TrimSpace(string(out)), "%d", &n)
	return n
}
