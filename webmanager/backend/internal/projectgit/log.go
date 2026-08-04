package projectgit

import (
	"fmt"
	"strconv"
	"strings"
)

// defaultLogLimit applies when the caller passes limit <= 0.
const defaultLogLimit = 30

// logFieldSep/logRecordSep delimit `git log --pretty=format:` output below.
// Both are ASCII control characters (unit/record separator) that can never
// appear in a commit's author name/email/date/subject, so no escaping or
// quoting concerns arise the way they would with a printable delimiter.
const (
	logFieldSep  = "\x1f"
	logRecordSep = "\x1e"
)

// Commit is one entry in a LogPage.
type Commit struct {
	Hash        string `json:"hash"`
	ShortHash   string `json:"shortHash"`
	AuthorName  string `json:"authorName"`
	AuthorEmail string `json:"authorEmail"`
	Date        string `json:"date"` // ISO 8601 / RFC3339, author date
	Subject     string `json:"subject"`
}

// LogPage is one page of commit history, oldest-cursor-first pagination
// (same cursor-pagination shape as internal/claudecode.ReadSessionLines /
// internal/logstore's cursor idiom: request limit+1, trim the extra one to
// derive HasMore, hand back an opaque cursor for the next page).
type LogPage struct {
	Commits    []Commit `json:"commits"`
	HasMore    bool     `json:"hasMore"`
	NextCursor string   `json:"nextCursor,omitempty"`
}

// Log returns up to limit commits reachable from HEAD, starting after
// cursor. cursor is an opaque string produced by a previous LogPage's
// NextCursor ("" for the first page) — concretely a `git log --skip=N`
// offset, but callers must treat it as opaque. A brand new repo with no
// commits yet yields an empty, non-error LogPage.
func Log(path string, limit int, cursor string) (LogPage, error) {
	if !IsGitRepo(path) {
		return LogPage{}, ErrNotGitRepo
	}
	if limit <= 0 {
		limit = defaultLogLimit
	}
	skip := 0
	if cursor != "" {
		if n, err := strconv.Atoi(cursor); err == nil && n > 0 {
			skip = n
		}
	}

	format := strings.Join([]string{"%H", "%h", "%an", "%ae", "%aI", "%s"}, logFieldSep) + logRecordSep
	out, err := runGit(path, "log",
		fmt.Sprintf("--skip=%d", skip),
		fmt.Sprintf("-n%d", limit+1),
		"--pretty=format:"+format,
	)
	if err != nil {
		if strings.Contains(err.Error(), "does not have any commits yet") {
			return LogPage{Commits: []Commit{}}, nil
		}
		return LogPage{}, err
	}

	records := strings.Split(string(out), logRecordSep)
	commits := make([]Commit, 0, limit)
	for _, rec := range records {
		rec = strings.Trim(rec, "\n")
		if rec == "" {
			continue
		}
		fields := strings.Split(rec, logFieldSep)
		if len(fields) < 6 {
			continue // malformed record — skip rather than fail the whole page
		}
		commits = append(commits, Commit{
			Hash:        fields[0],
			ShortHash:   fields[1],
			AuthorName:  fields[2],
			AuthorEmail: fields[3],
			Date:        fields[4],
			Subject:     fields[5],
		})
	}

	page := LogPage{Commits: commits}
	if len(commits) > limit {
		page.Commits = commits[:limit]
		page.HasMore = true
		page.NextCursor = strconv.Itoa(skip + limit)
	}
	return page, nil
}
