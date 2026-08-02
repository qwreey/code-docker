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
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
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
