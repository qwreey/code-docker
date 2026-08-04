package projectgit

import (
	"regexp"
	"strconv"
	"strings"
)

// noCommitsPrefix is git's header text for a freshly-initialized branch with
// no commits yet, e.g. "## No commits yet on main".
const noCommitsPrefix = "No commits yet on "

// detachedHeadHeader is git's exact header text for a detached HEAD, e.g.
// "## HEAD (no branch)".
const detachedHeadHeader = "HEAD (no branch)"

// parseBranchLine parses the first line of `git status --porcelain=v1 -b`
// output — always "## ..." — into a branch name and ahead/behind/diverged
// tracking counts, mirroring _qtm_git_info.fish's tracking-info parsing.
// Observed git formats:
//
//	## main                              (no upstream)
//	## main...origin/main                (up to date with upstream)
//	## main...origin/main [ahead 1]
//	## main...origin/main [behind 2]
//	## main...origin/main [ahead 1, behind 2]
//	## main...origin/main [gone]         (upstream deleted; bracket ignored)
//	## No commits yet on main
//	## HEAD (no branch)                  (detached; branch returned "")
//
// A real git status -b never actually emits the literal word "diverged" in
// the bracket (ahead+behind are reported together, as above) — the
// "diverged" case is parsed anyway, purely to mirror the fish script's own
// (equally dead) case exactly rather than silently dropping it.
func parseBranchLine(line string) (branch string, ahead, behind, diverged int) {
	if !strings.HasPrefix(line, "## ") {
		return "", 0, 0, 0
	}
	rest := strings.TrimPrefix(line, "## ")

	if rest == detachedHeadHeader {
		return "", 0, 0, 0
	}
	if strings.HasPrefix(rest, noCommitsPrefix) {
		return strings.TrimPrefix(rest, noCommitsPrefix), 0, 0, 0
	}

	branchPart := rest
	bracket := ""
	if idx := strings.Index(rest, " ["); idx != -1 && strings.HasSuffix(rest, "]") {
		branchPart = rest[:idx]
		bracket = rest[idx+2 : len(rest)-1]
	}
	if idx := strings.Index(branchPart, "..."); idx != -1 {
		branchPart = branchPart[:idx]
	}
	branch = branchPart

	if bracket == "" {
		return branch, 0, 0, 0
	}
	for _, item := range strings.Split(bracket, ",") {
		item = strings.TrimSpace(item)
		parts := strings.SplitN(item, " ", 2)
		n := 0
		if len(parts) == 2 {
			n, _ = strconv.Atoi(strings.TrimSpace(parts[1]))
		}
		switch parts[0] {
		case "behind":
			behind = n
		case "ahead":
			ahead = n
		case "diverged":
			diverged = n
		}
	}
	return branch, ahead, behind, diverged
}

// Status-line classification regexes, applied in this exact order to match
// _qtm_git_info.fish's own if/else-if chain. Each matches against the first
// two (XY) characters of a non-header `git status --porcelain=v1` line.
var (
	reConflict          = regexp.MustCompile(`^(?:U[ADU]|[AD]U|AA|DD)`)
	reUntracked         = regexp.MustCompile(`^\?\?`)
	reBothIndexWorktree = regexp.MustCompile(`^[MTARC][MTD]`)
	reStagedOnly        = regexp.MustCompile(`^[MTADRC] `)
	reChangedOnly       = regexp.MustCompile(`^ [MTADRC]`)
)

// classifyStatusLine classifies one non-header, non-ignored-marker
// `git status --porcelain=v1` line by its two-character XY status code,
// mirroring _qtm_git_info.fish's classification exactly, including its
// match order (conflict, then untracked, then combined index+worktree, then
// staged-only, then changed-only). A line can report both staged and
// changed simultaneously (e.g. "MM" — modified in the index AND further
// modified in the worktree since being staged), matching the fish script's
// behavior of falling through the combined-check case rather than treating
// staged/changed as mutually exclusive.
func classifyStatusLine(line string) (conflict, untracked, staged, changed bool) {
	switch {
	case reConflict.MatchString(line):
		conflict = true
	case reUntracked.MatchString(line):
		untracked = true
	case reBothIndexWorktree.MatchString(line):
		staged, changed = true, true
	case reStagedOnly.MatchString(line):
		staged = true
	case reChangedOnly.MatchString(line):
		changed = true
	}
	return
}
