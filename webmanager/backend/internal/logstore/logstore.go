// Package logstore reads the JSON-lines log files produced by the vector
// pipeline (see webmanager/.claude/vector-logs-plan-done.md): one file per day at
// <dir>/<YYYY-MM-DD>.jsonl, newline-delimited JSON objects with fields
// timestamp/app_name/level/message. That producer is a separate, parallel
// effort — this package must tolerate the directory or today's/yesterday's
// file not existing yet (that's just "no entries", not an error) and must
// skip individual malformed lines rather than fail the whole read (a
// partially-written line from an in-progress append is expected).
package logstore

import (
	"bufio"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
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

// dayFileNames returns the filenames (not full paths) for today and
// yesterday, most-recent first. Day-partitioned files are read instead of
// globbing every file the producer has ever written, since this container
// is long-lived and an unbounded glob would mean unbounded I/O per request
// as history accumulates; two days is enough of a buffer for a "recent
// logs" viewer without that cost.
func dayFileNames(now time.Time) []string {
	const layout = "2006-01-02.jsonl"
	return []string{
		now.Format(layout),
		now.AddDate(0, 0, -1).Format(layout),
	}
}

// ReadEntries loads log entries from the most recent day-files in dir,
// optionally filtered by app (exact match on app_name) and level (exact
// match on level), sorted by timestamp descending, and clamped to limit
// entries. A missing dir, missing day-files, or an empty dir all just yield
// zero entries rather than an error.
func ReadEntries(dir string, app, level string, limit int) ([]Entry, error) {
	entries := make([]Entry, 0)

	// UTC, not local time: vector's own file-sink path templating keys
	// day-filenames off each event's (UTC) timestamp, so computing "today"
	// in local time would drift from vector's filenames for several hours
	// around local midnight if this container's TZ is ever set to a
	// non-UTC zone.
	for _, name := range dayFileNames(time.Now().UTC()) {
		path := filepath.Join(dir, name)
		fileEntries, err := readFile(path, app, level)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		entries = append(entries, fileEntries...)
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Timestamp > entries[j].Timestamp
	})

	if limit > 0 && len(entries) > limit {
		entries = entries[:limit]
	}
	return entries, nil
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
