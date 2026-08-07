// Package envmigrate implements the parsing/merge logic behind
// `webmanager --env-migrate` / `router-manager --env-migrate` (see
// webmanager/.claude/archive/env-migration-plan-done.md for the full
// design). It reconciles a user's existing env file against the image's
// current template: keys the user actively uncommented are kept, comments
// the user wrote themselves are preserved, keys the template no longer has
// are archived instead of dropped, and the template's own key set/order/
// section structure always wins (so added or renamed keys show up
// automatically).
//
// Shared by more than one tool (webmanager, router-manager), so nothing in
// this package hardcodes a version-key name or file name — callers pass
// those in via Options.
package envmigrate

import (
	"fmt"
	"regexp"
	"strings"
)

// Options parameterizes the per-tool naming this package would otherwise
// have to hardcode (version-key env var name, and the file names used in
// human-readable migration notes).
type Options struct {
	// VersionKey is the env var name that tracks the template's schema
	// version (e.g. "WEBMANAGER_ENV_VERSION", "ROUTER_ENV_VERSION").
	VersionKey string
	// EnvFileName is the live, user-editable file's name (e.g.
	// ".env.webmanager"), used only in human-readable migration notes.
	EnvFileName string
	// TemplateFileName is the shipped template's name (e.g.
	// "example-env.webmanager"), used only in human-readable migration
	// notes.
	TemplateFileName string
}

// keyRe matches a bare "KEY=" (no leading marker) — deliberately stricter
// than a typical env var name regex: no whitespace before "=", and the
// leading char must be a letter so a stray "#123=foo" comment doesn't get
// misread as a value line.
var keyRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]*=`)

type lineKind int

const (
	kindBlank lineKind = iota
	kindValue
	kindDeadValue     // #~KEY=value — archived (removed) key, always inert
	kindDeadComment   // #~<prose> — comment attached to an archived key
	kindForceMarker   // exact "#!important" — template-only, forces the value below
	kindFlagMarker    // exact "#!" — template-only, flags the value below for conflict display
	kindAdvisoryEcho  // #!KEY=... — our own leftover conflict-echo, regenerated every run
	kindAdvisoryProse // #!<prose> — our own leftover conflict explanation, regenerated every run
	kindAutoComment   // #.<prose> — ours, regenerated every run
	kindUserComment   // plain #<prose> — the user's own, preserved
	kindOther         // anything else (shouldn't normally occur in a well-formed file)
)

type classified struct {
	kind   lineKind
	key    string
	active bool
	value  string
	text   string // comment body, without its prefix
}

func splitKV(s string) (string, string) {
	i := strings.IndexByte(s, '=')
	return s[:i], s[i+1:]
}

func classifyLine(line string) classified {
	if strings.TrimSpace(line) == "" {
		return classified{kind: kindBlank}
	}
	if rest, ok := strings.CutPrefix(line, "#~"); ok {
		if keyRe.MatchString(rest) {
			key, val := splitKV(rest)
			return classified{kind: kindDeadValue, key: key, value: val}
		}
		return classified{kind: kindDeadComment, text: rest}
	}
	if line == "#!important" {
		return classified{kind: kindForceMarker}
	}
	if line == "#!" {
		return classified{kind: kindFlagMarker}
	}
	if rest, ok := strings.CutPrefix(line, "#!"); ok {
		if keyRe.MatchString(rest) {
			return classified{kind: kindAdvisoryEcho}
		}
		return classified{kind: kindAdvisoryProse}
	}
	if rest, ok := strings.CutPrefix(line, "#."); ok {
		return classified{kind: kindAutoComment, text: rest}
	}
	if rest, ok := strings.CutPrefix(line, "#"); ok {
		if keyRe.MatchString(rest) {
			key, val := splitKV(rest)
			return classified{kind: kindValue, key: key, active: false, value: val}
		}
		return classified{kind: kindUserComment, text: rest}
	}
	if keyRe.MatchString(line) {
		key, val := splitKV(line)
		return classified{kind: kindValue, key: key, active: true, value: val}
	}
	return classified{kind: kindOther}
}

// isCommentLike reports whether a line can be part of a value's "attached
// comment block" — everything except a blank line, a value line, or an
// unrecognized stray line (any of the three end the upward scan).
func isCommentLike(k lineKind) bool {
	switch k {
	case kindDeadComment, kindForceMarker, kindFlagMarker, kindAdvisoryEcho, kindAdvisoryProse, kindAutoComment, kindUserComment:
		return true
	default:
		return false
	}
}

// attachedBlockStart scans upward from a value/dead-value line at idx,
// collecting contiguous comment-like lines, and returns the index of the
// first line of that block (idx itself if there's no block).
func attachedBlockStart(cls []classified, idx int) int {
	i := idx - 1
	for i >= 0 && isCommentLike(cls[i].kind) {
		i--
	}
	return i + 1
}

// OldEntry is a key's state as found in the user's existing env file.
type OldEntry struct {
	Active bool
	Value  string
	// UserComments holds each attached plain-`#` comment line's body (prefix
	// already stripped), one slice entry per line, in original order. A bare
	// "#" spacer line is represented as "".
	UserComments []string
}

// DeadEntry is a key already archived under (or newly moved into) the
// output's "#~" dead-keys section.
type DeadEntry struct {
	Key          string
	Value        string
	UserComments []string
}

// Old is the fully parsed state of a user's existing env file.
type Old struct {
	Entries map[string]OldEntry
	// EntryOrder preserves first-appearance order of Entries' keys — maps
	// don't, and dead-key archival needs to append newly-removed keys in
	// the order the user's file originally had them.
	EntryOrder []string
	Dead       []DeadEntry
	// Version is the version key's old active value, or "" if unset/
	// inactive (e.g. a file that predates this feature entirely).
	Version string
	Notes   []Note
}

func parseOld(content, versionKey string) Old {
	lines := strings.Split(content, "\n")
	cls := make([]classified, len(lines))
	for i, l := range lines {
		cls[i] = classifyLine(l)
	}

	entries := map[string]OldEntry{}
	var order []string
	seenCount := map[string]int{}
	var dead []DeadEntry
	deadIndex := map[string]int{}
	var notes []Note

	for i, c := range cls {
		switch c.kind {
		case kindValue:
			start := attachedBlockStart(cls, i)
			var comments []string
			for j := start; j < i; j++ {
				if cls[j].kind == kindUserComment {
					comments = append(comments, cls[j].text)
				}
			}
			if _, ok := entries[c.key]; !ok {
				order = append(order, c.key)
			}
			seenCount[c.key]++
			entries[c.key] = OldEntry{Active: c.active, Value: c.value, UserComments: comments}
		case kindDeadValue:
			start := attachedBlockStart(cls, i)
			var comments []string
			for j := start; j < i; j++ {
				if cls[j].kind == kindDeadComment {
					comments = append(comments, cls[j].text)
				}
			}
			if idx, ok := deadIndex[c.key]; ok {
				dead[idx] = DeadEntry{Key: c.key, Value: c.value, UserComments: comments}
			} else {
				deadIndex[c.key] = len(dead)
				dead = append(dead, DeadEntry{Key: c.key, Value: c.value, UserComments: comments})
			}
		}
	}

	for key, count := range seenCount {
		if count > 1 {
			notes = append(notes, Note{Level: "WARN", Message: fmt.Sprintf("%s appeared %d times in the input, last occurrence wins", key, count)})
		}
	}

	version := ""
	if e, ok := entries[versionKey]; ok && e.Active {
		version = e.Value
	}

	return Old{Entries: entries, EntryOrder: order, Dead: dead, Version: version, Notes: notes}
}

// ParseVersion extracts versionKey's active value from an env-file-shaped
// document (used on both the template, to get the image's current version,
// and the live file, to get its current version). Returns "" if unset/
// inactive.
func ParseVersion(content, versionKey string) string {
	for _, line := range strings.Split(content, "\n") {
		c := classifyLine(line)
		if c.kind == kindValue && c.active && c.key == versionKey {
			return c.value
		}
	}
	return ""
}

// Note is a single stderr-worthy line from a migration run. Level is "INFO"
// (fully automatic, no user action needed — an org's #!important took
// effect) or "WARN" (worth a human look — a #! conflict was kept as-is, or
// a key got archived to the dead-keys section).
type Note struct {
	Level   string
	Message string
}

// Result is Migrate's output: the reconstructed file content plus any notes
// to surface on stderr.
type Result struct {
	Output string
	Notes  []Note
}

// Migrate reconstructs a live env file from old (the user's existing file,
// possibly empty for a fresh install) against template (the image's current
// shipped template). See the package doc and
// webmanager/.claude/archive/env-migration-plan-done.md for the full
// behavior.
func Migrate(old, template string, opts Options) Result {
	// Trim a single trailing newline before splitting so it doesn't show up
	// as a phantom empty final line — otherwise it'd either double up with
	// the "\n" this function always appends to its own output, or throw off
	// the blank-line spacing before an appended dead-keys section.
	oldParsed := parseOld(strings.TrimSuffix(old, "\n"), opts.VersionKey)

	tLines := strings.Split(strings.TrimSuffix(template, "\n"), "\n")
	tCls := make([]classified, len(tLines))
	for i, l := range tLines {
		tCls[i] = classifyLine(l)
	}

	templateKeys := map[string]bool{}
	for _, c := range tCls {
		if c.kind == kindValue {
			templateKeys[c.key] = true
		}
	}

	templateVersion := ""
	for _, c := range tCls {
		if c.kind == kindValue && c.key == opts.VersionKey {
			templateVersion = c.value
		}
	}

	// blockStartOf[i] = the value-line index whose attached comment block
	// starts at line i (i itself if that value has no block at all).
	blockStartOf := map[int]int{}
	forced := map[int]bool{}
	flagged := map[int]bool{}
	for i, c := range tCls {
		if c.kind != kindValue {
			continue
		}
		start := attachedBlockStart(tCls, i)
		blockStartOf[start] = i
		for j := start; j < i; j++ {
			switch tCls[j].kind {
			case kindForceMarker:
				forced[i] = true
			case kindFlagMarker:
				flagged[i] = true
			}
		}
	}

	notes := append([]Note{}, oldParsed.Notes...)
	var out []string

	for i := 0; i < len(tCls); i++ {
		if vIdx, ok := blockStartOf[i]; ok {
			key := tCls[vIdx].key
			if !forced[vIdx] {
				if oe, hasOld := oldParsed.Entries[key]; hasOld {
					for _, uc := range oe.UserComments {
						if uc == "" {
							out = append(out, "#")
						} else {
							out = append(out, "#"+uc)
						}
					}
				}
			}
		}

		c := tCls[i]
		switch c.kind {
		case kindForceMarker, kindFlagMarker:
			// Template-only syntax — never copied into the output.
			continue
		case kindValue:
			key := c.key
			oe, hasOld := oldParsed.Entries[key]

			switch {
			case forced[i]:
				out = append(out, key+"="+c.value)
				oldDesc := "unset"
				changed := true
				if hasOld {
					if oe.Active {
						oldDesc = fmt.Sprintf("%q", oe.Value)
						changed = oe.Value != c.value
					} else {
						oldDesc = "commented out"
					}
				}
				if changed {
					notes = append(notes, Note{Level: "INFO", Message: fmt.Sprintf("%s forced to %q (was %s) — #!important", key, c.value, oldDesc)})
				}
			case flagged[i] && hasOld && oe.Active:
				fromV := oldParsed.Version
				if fromV == "" {
					fromV = "알수없음"
				}
				out = append(out,
					fmt.Sprintf("#! %s 버전 %s → %s 마이그레이션 중 이 키의 권장 기본값이", opts.EnvFileName, fromV, templateVersion),
					"#! 바뀌었습니다. 아래는 새 권장값이고, 지금 값은 그대로 유지됩니다 —",
					"#! 필요하면 직접 바꾸세요.",
					"#!"+key+"="+c.value,
				)
				out = append(out, key+"="+oe.Value)
				notes = append(notes, Note{Level: "WARN", Message: fmt.Sprintf("%s recommended value changed (kept user value %q, template now suggests %q)", key, oe.Value, c.value)})
			case hasOld && oe.Active:
				out = append(out, key+"="+oe.Value)
			default:
				out = append(out, tLines[i])
			}
		default:
			out = append(out, tLines[i])
		}
	}

	var deadOut []DeadEntry
	for _, d := range oldParsed.Dead {
		if !templateKeys[d.Key] {
			deadOut = append(deadOut, d)
		}
		// Else: the key reappeared in the template — per policy, it's
		// treated as a brand-new key (template default applies via the
		// normal walk above), the old archived value is not resurrected.
	}
	for _, key := range oldParsed.EntryOrder {
		if templateKeys[key] {
			continue
		}
		alreadyCarried := false
		for _, d := range deadOut {
			if d.Key == key {
				alreadyCarried = true
				break
			}
		}
		if alreadyCarried {
			continue
		}
		oe := oldParsed.Entries[key]
		if !oe.Active {
			// Never activated by the user — dropping it has no user-visible
			// effect, so skip archiving it to avoid cluttering the
			// dead-keys section with keys nobody ever touched.
			continue
		}
		deadOut = append(deadOut, DeadEntry{Key: key, Value: oe.Value, UserComments: oe.UserComments})
		notes = append(notes, Note{Level: "WARN", Message: fmt.Sprintf("%s removed from template (moved to #~ dead-keys section, was set to %q)", key, oe.Value)})
	}

	if len(deadOut) > 0 {
		out = append(out, "",
			"#. ------------------------------------------------------------------",
			fmt.Sprintf("#. 아래는 예전 %s에는 있었지만 이 버전의 %s", opts.EnvFileName, opts.TemplateFileName),
			"#. 에는 더 이상 없는 키입니다(더 이상 쓰이지 않음). 필요 없으면 통째로",
			"#. 지우세요.",
			"#. ------------------------------------------------------------------",
		)
		for _, d := range deadOut {
			for _, uc := range d.UserComments {
				if uc == "" {
					out = append(out, "#~")
				} else {
					out = append(out, "#~"+uc)
				}
			}
			out = append(out, "#~"+d.Key+"="+d.Value)
		}
	}

	return Result{Output: strings.Join(out, "\n") + "\n", Notes: notes}
}
