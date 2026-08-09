// Claude Code CLI auto-memory reader — the persistent per-project notes the
// CLI writes to CLAUDE_CONFIG_DIR/projects/<slug>/memory/ (MEMORY.md index +
// one file per memory entry). Read-only, like internal/claudecode's session
// transcripts: this package only understands enough of the on-disk shape to
// list/parse it, degrading per-file rather than failing the whole read (same
// convention as internal/claudecode.ListSessions/internal/logstore).
package claudememory

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// projectsDirName/memorySubdir/indexFileName mirror the fixed on-disk layout
// Claude Code CLI itself writes — not user-configurable.
const (
	projectsDirName = "projects"
	memorySubdir    = "memory"
	indexFileName   = "MEMORY.md"
)

// slugReplacer derives the <slug> directory Claude Code CLI uses for a given
// absolute project path: every `/` and `.` replaced by `-` (empirically
// verified on-disk — e.g. "/home/yaeji/Projects/code-docker" becomes
// "-home-yaeji-Projects-code-docker").
var slugReplacer = strings.NewReplacer("/", "-", ".", "-")

// ProjectSlug derives the CLAUDE_CONFIG_DIR/projects/<slug> segment for an
// absolute project path.
func ProjectSlug(projectPath string) string {
	return slugReplacer.Replace(projectPath)
}

// indexEntryRe matches one MEMORY.md bullet line: "- [Title](file.md) —
// summary". The trailing separator/summary is handled loosely in code below
// (trimmed of a leading "—" or "-") rather than in the regex itself, since a
// bare em dash in a Go regexp character class is easy to get wrong (reversed
// rune-range parse error) for no real benefit here.
var indexEntryRe = regexp.MustCompile(`^-\s+\[(.+?)\]\(([^)]+)\)(.*)$`)

// IndexEntry is one parsed MEMORY.md bullet.
type IndexEntry struct {
	Title    string `json:"title"`
	Filename string `json:"filename"`
	Summary  string `json:"summary"`
}

// File is one individual memory file: parsed YAML frontmatter fields plus
// the raw markdown body that follows it.
type File struct {
	Filename    string `json:"filename"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Type        string `json:"type"`
	Body        string `json:"body"`
}

// Memory is GET /api/claude/memory's payload. Exists is false whenever the
// memory/ directory itself is missing — the normal case for any project
// Claude Code has never run against — and IndexRaw/Index/Files stay at their
// zero values (empty, never nil, so they serialize as `[]`/`""` rather than
// `null`) rather than the request erroring.
type Memory struct {
	Exists   bool         `json:"exists"`
	IndexRaw string       `json:"indexRaw"`
	Index    []IndexEntry `json:"index"`
	Files    []File       `json:"files"`
}

// frontmatter is the subset of a memory file's YAML header this package
// understands — anything else in there is ignored.
type frontmatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
	Metadata    struct {
		Type string `yaml:"type"`
	} `yaml:"metadata"`
}

// Load reads projectPath's memory directory under configDir. A missing
// directory is not an error — it returns Memory{Exists: false} with empty
// (non-nil) slices. Any other read failure on the directory itself is
// returned as an error; failures on individual files inside it are skipped
// rather than failing the whole call (matching internal/claudecode's
// per-file degrade convention).
func Load(configDir, projectPath string) (Memory, error) {
	slug := ProjectSlug(projectPath)

	root := filepath.Join(configDir, projectsDirName)
	dir := filepath.Join(root, slug, memorySubdir)

	// Defense in depth beyond the deterministic replacer above (which can
	// never itself produce ".." — every "." is replaced too) — same
	// containment check idiom as claudecode.resolveSessionPath.
	cleanRoot := filepath.Clean(root) + string(filepath.Separator)
	if !strings.HasPrefix(filepath.Clean(dir), cleanRoot) {
		return Memory{}, fmt.Errorf("invalid project path")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return Memory{Index: []IndexEntry{}, Files: []File{}}, nil
		}
		return Memory{}, err
	}

	mem := Memory{Exists: true, Index: []IndexEntry{}, Files: []File{}}

	if raw, err := os.ReadFile(filepath.Join(dir, indexFileName)); err == nil {
		mem.IndexRaw = string(raw)
		mem.Index = parseIndex(mem.IndexRaw)
	}

	for _, e := range entries {
		if e.IsDir() || e.Name() == indexFileName || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		f := parseFile(raw)
		f.Filename = e.Name()
		mem.Files = append(mem.Files, f)
	}
	sort.Slice(mem.Files, func(i, j int) bool { return mem.Files[i].Filename < mem.Files[j].Filename })

	return mem, nil
}

// parseIndex extracts every recognizable bullet from MEMORY.md's raw text.
// A line that doesn't match the expected bullet shape is skipped rather
// than failing the whole parse — MEMORY.md is a plain markdown file a user
// could hand-edit.
func parseIndex(raw string) []IndexEntry {
	entries := []IndexEntry{}
	for _, line := range strings.Split(raw, "\n") {
		m := indexEntryRe.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m == nil {
			continue
		}
		summary := strings.TrimSpace(m[3])
		summary = strings.TrimPrefix(summary, "—")
		summary = strings.TrimPrefix(summary, "-")
		summary = strings.TrimSpace(summary)
		entries = append(entries, IndexEntry{Title: m[1], Filename: m[2], Summary: summary})
	}
	return entries
}

// parseFile splits raw into YAML frontmatter + body. A file with no
// "---"-delimited frontmatter (or unparseable YAML) just yields an empty
// Name/Description/Type with the whole content as Body — best-effort, not a
// hard schema requirement.
func parseFile(raw []byte) File {
	text := string(raw)

	const marker = "---"
	if !strings.HasPrefix(text, marker+"\n") {
		return File{Body: text}
	}

	rest := text[len(marker)+1:]
	end := strings.Index(rest, "\n"+marker)
	if end < 0 {
		return File{Body: text}
	}

	yamlPart := rest[:end]
	afterMarker := rest[end+len(marker)+1:]
	body := ""
	if idx := strings.IndexByte(afterMarker, '\n'); idx >= 0 {
		body = strings.TrimLeft(afterMarker[idx+1:], "\n")
	}

	var fm frontmatter
	_ = yaml.Unmarshal([]byte(yamlPart), &fm)

	return File{
		Name:        fm.Name,
		Description: fm.Description,
		Type:        fm.Metadata.Type,
		Body:        body,
	}
}
