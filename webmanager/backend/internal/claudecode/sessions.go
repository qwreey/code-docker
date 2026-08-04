// Session transcript reading — see webmanager/.claude/session-log-plan.md.
// This file deliberately does NOT understand the JSONL entry schema beyond
// the handful of fields needed for a cheap list preview: the full schema is
// vendored as a Zod module on the frontend (see that plan doc's "파싱
// 전략") and parsing/rendering happens entirely there. Every function here
// degrades per-file/per-line rather than failing the whole call, matching
// internal/logstore's convention — a broken or half-written transcript line
// is expected, not exceptional.
package claudecode

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// sessionsDirName is the fixed subdirectory of CLAUDE_CONFIG_DIR holding one
// directory per project, each containing that project's session transcripts.
const sessionsDirName = "projects"

// previewScanLines bounds how many lines of a transcript ListSessions reads
// looking for a preview snippet — transcripts can run to 10MB+, and the
// list endpoint must stay cheap even with many sessions.
const previewScanLines = 50

// previewMaxLen truncates the preview snippet so one long first message
// can't bloat the list response.
const previewMaxLen = 200

// safeIdentifier matches the project-dir/session-id path segments this
// package accepts: no `/`, no `..`, no empty string. Deliberately loose
// beyond that (not pinned to the UUID-looking format observed today) since
// the on-disk naming is an internal Claude Code implementation detail that
// could change — see claude-plan.md's format-drift warnings.
var safeIdentifier = regexp.MustCompile(`^[^/\\]+$`)

// SessionInfo is one entry in the session list — cheap metadata only, no
// full-file parse (see previewScanLines).
type SessionInfo struct {
	Project    string `json:"project"`
	SessionID  string `json:"sessionId"`
	Cwd        string `json:"cwd"`
	ModifiedAt string `json:"modifiedAt"`
	SizeBytes  int64  `json:"sizeBytes"`
	Preview    string `json:"preview"`
}

// ListSessions scans <configDir>/projects/*/*.jsonl (top-level files only —
// per-session subdirectories holding subagent transcripts/overflowed tool
// results are out of scope, see session-log-plan.md). A missing projects
// directory yields an empty list, not an error. A single unreadable project
// dir or session file is skipped rather than failing the whole scan.
func ListSessions(configDir string) ([]SessionInfo, error) {
	root := filepath.Join(configDir, sessionsDirName)

	projectDirs, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return []SessionInfo{}, nil
		}
		return nil, err
	}

	sessions := make([]SessionInfo, 0)
	for _, pd := range projectDirs {
		if !pd.IsDir() {
			continue
		}
		project := pd.Name()
		projectPath := filepath.Join(root, project)

		files, err := os.ReadDir(projectPath)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			sessionID := strings.TrimSuffix(f.Name(), ".jsonl")
			info, err := f.Info()
			if err != nil {
				continue
			}

			cwd, preview := scanPreview(filepath.Join(projectPath, f.Name()))
			sessions = append(sessions, SessionInfo{
				Project:    project,
				SessionID:  sessionID,
				Cwd:        cwd,
				ModifiedAt: info.ModTime().UTC().Format("2006-01-02T15:04:05Z07:00"),
				SizeBytes:  info.Size(),
				Preview:    preview,
			})
		}
	}

	sort.Slice(sessions, func(i, j int) bool { return sessions[i].ModifiedAt > sessions[j].ModifiedAt })
	return sessions, nil
}

// entryHeader is the minimal subset of one transcript line's fields
// scanPreview needs — deliberately not the full schema (that lives in the
// vendored frontend module).
type entryHeader struct {
	Type    string          `json:"type"`
	IsMeta  bool            `json:"isMeta"`
	Cwd     string          `json:"cwd"`
	Message *messageContent `json:"message"`
}

type messageContent struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// scanPreview reads at most previewScanLines lines of path looking for cwd
// (from any entry that carries it) and a preview snippet (the first
// non-meta user message's text). Any parse failure on a given line is
// silently skipped — this is a best-effort preview, not a correctness
// requirement.
func scanPreview(path string) (cwd, preview string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for i := 0; i < previewScanLines && scanner.Scan(); i++ {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var hdr entryHeader
		if err := json.Unmarshal(line, &hdr); err != nil {
			continue
		}
		if cwd == "" && hdr.Cwd != "" {
			cwd = hdr.Cwd
		}
		if preview != "" || hdr.Type != "user" || hdr.IsMeta || hdr.Message == nil {
			continue
		}
		if text := extractText(hdr.Message.Content); text != "" && !isSlashCommandArtifact(text) {
			preview = truncate(text, previewMaxLen)
		}
	}
	return cwd, preview
}

// extractText pulls plain text out of a message's content field, which is
// either a bare JSON string or an array of typed content blocks (only
// "text" blocks contribute). Any shape this doesn't recognize yields "".
func extractText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return strings.TrimSpace(s)
	}
	var blocks []contentBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		for _, b := range blocks {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				return strings.TrimSpace(b.Text)
			}
		}
	}
	return ""
}

// isSlashCommandArtifact recognizes the `<command-name>...`/`<local-command-
// stdout>...` wrapper text Claude Code's CLI inserts for slash-command
// invocations — only the surrounding `<local-command-caveat>` wrapper
// message carries isMeta:true, the command-name/stdout entries themselves
// don't, so they'd otherwise leak into the preview/chat view as if they
// were real conversation content.
func isSlashCommandArtifact(text string) bool {
	return strings.HasPrefix(text, "<command-name>") ||
		strings.HasPrefix(text, "<local-command-stdout>") ||
		strings.HasPrefix(text, "<local-command-stderr>")
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// resolveSessionPath validates project/sessionId as safe path segments and
// returns the transcript file they identify, only if it actually exists
// under <configDir>/projects. Rejects anything containing a path separator
// or ".." outright, then re-checks the joined+cleaned path is still
// contained under the projects root — defense in depth, not just relying on
// the regex (see webmanager/CLAUDE.md's path-validation convention).
func resolveSessionPath(configDir, project, sessionID string) (string, error) {
	if !safeIdentifier.MatchString(project) || !safeIdentifier.MatchString(sessionID) {
		return "", fmt.Errorf("invalid project or session id")
	}

	root := filepath.Join(configDir, sessionsDirName)
	path := filepath.Join(root, project, sessionID+".jsonl")

	cleanRoot := filepath.Clean(root) + string(filepath.Separator)
	if !strings.HasPrefix(filepath.Clean(path), cleanRoot) {
		return "", fmt.Errorf("invalid project or session id")
	}

	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return "", fmt.Errorf("session not found")
	}
	return path, nil
}

// ReadSessionLines returns raw JSONL lines [cursor, cursor+limit) from
// project/sessionId's transcript, unparsed — the frontend's vendored schema
// module does all interpretation. hasMore is determined by reading one line
// past limit rather than scanning the whole file for a total count (files
// observed up to ~10MB).
func ReadSessionLines(configDir, project, sessionID string, cursor, limit int) (lines []string, hasMore bool, err error) {
	path, err := resolveSessionPath(configDir, project, sessionID)
	if err != nil {
		return nil, false, err
	}
	if cursor < 0 {
		cursor = 0
	}
	if limit <= 0 {
		limit = 500
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	lines = make([]string, 0, limit)
	idx := 0
	for scanner.Scan() {
		if idx < cursor {
			idx++
			continue
		}
		if len(lines) == limit {
			hasMore = true
			break
		}
		lines = append(lines, scanner.Text())
		idx++
	}

	return lines, hasMore, nil
}
