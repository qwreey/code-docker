// Package logstore reads the JSON-lines log files produced by the vector
// pipeline (see webmanager/.claude/vector-logs-plan-done.md): one file per day at
// <dir>/<YYYY-MM-DD>.jsonl, newline-delimited JSON objects with fields
// timestamp/app_name/level/message. That producer is a separate, parallel
// effort — this package must tolerate the directory or any day-file not
// existing (that's just "no entries", not an error) and must skip individual
// malformed lines rather than fail the whole read (a partially-written line
// from an in-progress append is expected).
package logstore

import (
	"bufio"
	"bytes"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"webmanager/internal/atomicfile"
)

// Entry is one parsed, filtered-ready log line, already converted to the
// shape the HTTP layer wants (unix-millis timestamp instead of the raw
// RFC3339Nano string on disk).
type Entry struct {
	Timestamp int64 // unix milliseconds
	App       string
	Level     string
	Message   string
}

// rawLine mirrors the on-disk schema exactly (field names match the
// producer's contract: timestamp/app_name/level/message).
type rawLine struct {
	Timestamp string `json:"timestamp"`
	AppName   string `json:"app_name"`
	Level     string `json:"level"`
	Message   string `json:"message"`
}

// dateFileLayout is both the on-disk filename format (sans extension) and
// the format day-files are named with: <dir>/<dateFileLayout>.jsonl.
const dateFileLayout = "2006-01-02"

// availableDates globs dir for day-files and parses each filename (UTC, per
// the package doc) into the date it represents, in no particular order.
// Filenames that don't match the expected format are silently skipped —
// vector is the only writer into this directory, but a stray file shouldn't
// break the read. A missing dir just yields zero dates, not an error.
func availableDates(dir string) ([]time.Time, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		return nil, err
	}
	dates := make([]time.Time, 0, len(matches))
	for _, m := range matches {
		name := strings.TrimSuffix(filepath.Base(m), ".jsonl")
		d, err := time.Parse(dateFileLayout, name)
		if err != nil {
			continue
		}
		dates = append(dates, d)
	}
	return dates, nil
}

// AvailableRange returns the earliest and latest dates for which a log file
// exists in dir (by filename, UTC), or ok=false if none exist.
func AvailableRange(dir string) (earliest, latest time.Time, ok bool) {
	dates, err := availableDates(dir)
	if err != nil || len(dates) == 0 {
		return time.Time{}, time.Time{}, false
	}
	earliest, latest = dates[0], dates[0]
	for _, d := range dates[1:] {
		if d.Before(earliest) {
			earliest = d
		}
		if d.After(latest) {
			latest = d
		}
	}
	return earliest, latest, true
}

// ReadEntries reads log entries matching app/level, restricted to
// [startMs, endMs] (either may be 0 meaning unbounded on that side, unix
// millis), and further restricted to entries strictly older than beforeMs
// (0 = no cursor, i.e. start from the newest matching entry). Returns at
// most limit entries (already sorted newest-first) plus hasMore indicating
// whether at least one more matching entry exists beyond what was returned.
func ReadEntries(dir string, app, level string, startMs, endMs, beforeMs int64, limit int) ([]Entry, bool, error) {
	dates, err := availableDates(dir)
	if err != nil {
		return nil, false, err
	}

	// A day-file can contain entries from anywhere in that UTC day, so keep
	// any date whose [00:00, 24:00) range intersects [startMs, endMs], not
	// just dates falling exactly within it.
	filtered := make([]time.Time, 0, len(dates))
	for _, d := range dates {
		dayStart := d.UnixMilli()
		dayEnd := d.AddDate(0, 0, 1).UnixMilli()
		if startMs != 0 && dayEnd <= startMs {
			continue
		}
		if endMs != 0 && dayStart > endMs {
			continue
		}
		filtered = append(filtered, d)
	}
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].After(filtered[j]) })

	entries := make([]Entry, 0)
	for _, d := range filtered {
		path := filepath.Join(dir, d.Format(dateFileLayout)+".jsonl")
		fileEntries, err := readFile(path, app, level)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, false, err
		}

		dayEntries := make([]Entry, 0, len(fileEntries))
		for _, e := range fileEntries {
			if startMs != 0 && e.Timestamp < startMs {
				continue
			}
			if endMs != 0 && e.Timestamp > endMs {
				continue
			}
			if beforeMs != 0 && e.Timestamp >= beforeMs {
				continue
			}
			dayEntries = append(dayEntries, e)
		}
		sort.Slice(dayEntries, func(i, j int) bool {
			return dayEntries[i].Timestamp > dayEntries[j].Timestamp
		})
		entries = append(entries, dayEntries...)

		// Only check the stopping condition *after* a day-file has been
		// fully read and merged in: cutting a day short mid-file would risk
		// dropping entries from that day that sort ahead of ones we already
		// have from an earlier (older) day-file, corrupting the newest-first
		// order across the day boundary.
		if limit > 0 && len(entries) > limit {
			break
		}
	}

	hasMore := false
	if limit > 0 && len(entries) > limit {
		entries = entries[:limit]
		hasMore = true
	}
	return entries, hasMore, nil
}

// readFile parses one day-file, already applying the app/level filters so
// callers never hold more than one day's matching entries in memory at a
// time. Lines that fail to parse as JSON, or that parse but carry an
// unparseable timestamp, are skipped individually.
func readFile(path string, app, level string) ([]Entry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	entries := make([]Entry, 0)
	scanner := bufio.NewScanner(f)
	// Log lines can run longer than bufio.Scanner's 64KiB default token
	// size (long stack traces, etc.) — raise the max buffer rather than
	// silently truncating/erroring on those lines.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var raw rawLine
		if err := json.Unmarshal(line, &raw); err != nil {
			continue
		}
		ts, err := time.Parse(time.RFC3339Nano, raw.Timestamp)
		if err != nil {
			continue
		}
		if app != "" && raw.AppName != app {
			continue
		}
		if level != "" && raw.Level != level {
			continue
		}
		entries = append(entries, Entry{
			Timestamp: ts.UnixMilli(),
			App:       raw.AppName,
			Level:     raw.Level,
			Message:   raw.Message,
		})
	}
	if err := scanner.Err(); err != nil {
		// A scan error (most commonly bufio.ErrTooLong from a single line
		// exceeding the 1MiB buffer above) can't be resynced mid-token, so
		// lines after the failure point in this file are unrecoverable —
		// but that's a far better degradation than failing this file's
		// entire read (and, transitively, the whole ReadEntries/HTTP
		// request) over one oversized line from one app. Keep whatever was
		// scanned successfully before the error and stop here.
		log.Printf("logstore: %s: stopped scanning after error: %v", path, err)
	}
	return entries, nil
}

// appNamePattern mirrors the charset supervisord program names actually use
// (see config/supervisord.d/*.conf) — app is only ever compared in-memory
// against rawLine.AppName, never used as a path component, but validating it
// up front is cheap defense in depth and matches this repo's convention of
// rejecting an unsafe charset outright rather than trusting a caller.
var appNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// ValidAppName reports whether app is safe to pass to PurgeApp.
func ValidAppName(app string) bool {
	return appNamePattern.MatchString(app)
}

// ValidDate reports whether date matches dateFileLayout exactly, i.e. is
// safe to pass to PurgeDate.
func ValidDate(date string) bool {
	_, err := time.Parse(dateFileLayout, date)
	return err == nil
}

// PurgeApp removes every log line whose app_name matches app from every
// day-file under dir, rewriting a file only if it actually contained at
// least one matching line. app must already be validated via ValidAppName.
func PurgeApp(dir, app string) error {
	matches, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		return err
	}
	for _, path := range matches {
		if err := purgeAppFromFile(path, app); err != nil {
			return err
		}
	}
	return nil
}

// purgeAppFromFile rewrites path with every line whose app_name matches app
// dropped, via the atomicfile temp-file+rename helper. Lines that fail to
// parse as JSON are kept as-is (same tolerance as readFile — a purge must
// never destroy a line it can't positively identify as a match), and the
// file is left untouched entirely if nothing matched, avoiding a needless
// rewrite of every other app's day-file on every purge.
func purgeAppFromFile(path, app string) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var kept bytes.Buffer
	changed := false
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) > 0 {
			var raw rawLine
			if err := json.Unmarshal(line, &raw); err == nil && raw.AppName == app {
				changed = true
				continue
			}
		}
		kept.Write(line)
		kept.WriteByte('\n')
	}
	scanErr := scanner.Err()
	f.Close()
	if scanErr != nil {
		// Unlike readFile's read-only degradation, rewriting past a scan
		// error here would permanently truncate whatever comes after the
		// failure point in this file — data loss well beyond the lines
		// actually being purged. Abort this file's rewrite entirely and
		// surface the error rather than risk that.
		return scanErr
	}
	if !changed {
		return nil
	}
	return atomicfile.Write(path, kept.Bytes(), 0o644, 0o755)
}

// PurgeDate deletes the day-file for date (already validated via ValidDate)
// under dir outright. Deleting an already-missing file is not an error,
// matching the package's general "missing file = no entries" tolerance.
func PurgeDate(dir, date string) error {
	path := filepath.Join(dir, date+".jsonl")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
