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
	"container/heap"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
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
//
// Each day-file is still parsed in full - entries from several sources are
// only roughly in time order within it - but only the newest entries that
// can still make the page are kept, so memory follows limit, not the size
// of the day's logs.
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

	match := func(e Entry) bool {
		if app != "" && e.App != app {
			return false
		}
		if level != "" && e.Level != level {
			return false
		}
		if startMs != 0 && e.Timestamp < startMs {
			return false
		}
		if endMs != 0 && e.Timestamp > endMs {
			return false
		}
		return beforeMs == 0 || e.Timestamp < beforeMs
	}

	entries := make([]Entry, 0)
	for _, d := range filtered {
		// One more than the page, to know whether there is more.
		keep := 0
		if limit > 0 {
			keep = limit + 1 - len(entries)
		}
		path := filepath.Join(dir, d.Format(dateFileLayout)+".jsonl")
		dayEntries, err := readFile(path, match, keep)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, false, err
		}
		entries = append(entries, dayEntries...)

		// Day-files cover disjoint days, newest first, so a day can't hold
		// anything that sorts ahead of what earlier days already gave.
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

// newestEntries is a min-heap on Timestamp: its root is the oldest entry
// kept, the one to drop when a newer one arrives and the heap is full.
type newestEntries []Entry

func (h newestEntries) Len() int           { return len(h) }
func (h newestEntries) Less(i, j int) bool { return h[i].Timestamp < h[j].Timestamp }
func (h newestEntries) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *newestEntries) Push(x any)        { *h = append(*h, x.(Entry)) }
func (h *newestEntries) Pop() any {
	old := *h
	e := old[len(old)-1]
	*h = old[:len(old)-1]
	return e
}

// maxLineBytes bounds the one line held in memory while reading. Longer
// lines (a huge stack trace) are skipped, and reading goes on after them.
const maxLineBytes = 1 << 20

// readFile parses one day-file and returns the newest max entries that
// match (all of them if max is 0), newest first. Lines that fail to parse
// as JSON, or that parse but carry an unparseable timestamp, are skipped
// individually.
func readFile(path string, match func(Entry) bool, max int) ([]Entry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var kept newestEntries
	skipped := 0
	err = eachLine(f, func(line []byte) {
		if line == nil {
			skipped++
			return
		}
		var raw rawLine
		if err := json.Unmarshal(line, &raw); err != nil {
			return
		}
		ts, err := time.Parse(time.RFC3339Nano, raw.Timestamp)
		if err != nil {
			return
		}
		e := Entry{Timestamp: ts.UnixMilli(), App: raw.AppName, Level: raw.Level, Message: raw.Message}
		if !match(e) {
			return
		}
		switch {
		case max <= 0 || kept.Len() < max:
			heap.Push(&kept, e)
		case e.Timestamp > kept[0].Timestamp:
			kept[0] = e
			heap.Fix(&kept, 0)
		}
	})
	if skipped > 0 {
		log.Printf("logstore: %s: skipped %d line(s) over %d bytes", path, skipped, maxLineBytes)
	}
	if err != nil {
		// Whatever was read before a read error is still worth showing.
		log.Printf("logstore: %s: stopped reading after error: %v", path, err)
	}
	out := []Entry(kept)
	sort.Slice(out, func(i, j int) bool { return out[i].Timestamp > out[j].Timestamp })
	return out, nil
}

// eachLine calls fn with every line of r, without its newline, and with nil
// for a line longer than maxLineBytes (which is skipped rather than ending
// the read: bufio.Scanner used to stop at the first such line, dropping the
// rest of the day from the Logs page).
func eachLine(r io.Reader, fn func(line []byte)) error {
	br := bufio.NewReaderSize(r, 64*1024)
	var long []byte
	tooLong := false
	for {
		chunk, err := br.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			if !tooLong {
				long = append(long, chunk...)
				if len(long) > maxLineBytes {
					tooLong, long = true, nil
				}
			}
			continue
		}
		if len(chunk) > 0 || long != nil || tooLong {
			if long != nil && len(long)+len(bytes.TrimSuffix(chunk, []byte("\n"))) > maxLineBytes {
				tooLong = true
			}
			switch {
			case tooLong:
				fn(nil)
			case long != nil:
				fn(bytes.TrimSuffix(append(long, chunk...), []byte("\n")))
			default:
				if line := bytes.TrimSuffix(chunk, []byte("\n")); len(line) > 0 {
					fn(line)
				}
			}
			long, tooLong = nil, false
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
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

// purgeMu serializes purges: two at once would read the same file and the
// second rewrite would put back what the first removed (and they shared
// atomicfile's fixed temporary name).
var purgeMu sync.Mutex

// vectorMayHaveOpen reports whether vector may still hold info's file open.
// Its file sink keeps a day-file open and appends to it until the file has
// been idle for idle_timeout_secs (30 s by default), which with steady logs
// is all day. Replacing such a file by rename, or removing it, sends every
// later line to an unlinked inode the Logs page never sees, so those files
// are changed in place instead. A few minutes is generous: a file older
// than that has been closed.
func vectorMayHaveOpen(info os.FileInfo) bool {
	return time.Since(info.ModTime()) < 5*time.Minute
}

// PurgeApp removes every log line whose app_name matches app from every
// day-file under dir, rewriting a file only if it actually contained at
// least one matching line. app must already be validated via ValidAppName.
func PurgeApp(dir, app string) error {
	purgeMu.Lock()
	defer purgeMu.Unlock()
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
// dropped. Lines that fail to parse as JSON, or are too long to parse, are
// kept as-is (a purge must never destroy a line it can't positively
// identify as a match), and the file is left untouched entirely if nothing
// matched, avoiding a needless rewrite of every other app's day-file on
// every purge.
//
// A file vector may still be appending to is rewritten in place
// (vectorMayHaveOpen): truncate and write back what is kept, after picking
// up and filtering whatever was appended while it was being read. A line
// appended in the instant between that last read and the truncate can
// still be lost; the rename this replaces lost everything after it.
func purgeAppFromFile(path, app string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}

	var kept bytes.Buffer
	changed := false
	filter := func(r io.Reader) (int64, error) {
		cr := &countingReader{r: r}
		err := eachRawLine(cr, func(line []byte, parse bool) {
			if parse {
				var raw rawLine
				if err := json.Unmarshal(bytes.TrimSuffix(line, []byte("\n")), &raw); err == nil && raw.AppName == app {
					changed = true
					return
				}
			}
			kept.Write(line)
		})
		return cr.n, err
	}
	n, err := filter(f)
	if err != nil {
		// Rewriting past a read error would permanently truncate whatever
		// comes after the failure point - data loss well beyond the lines
		// actually being purged. Leave this file alone.
		return err
	}
	if !changed {
		return nil
	}
	if !vectorMayHaveOpen(info) {
		return atomicfile.Write(path, kept.Bytes(), 0o644, 0o755)
	}
	if _, err := filter(io.NewSectionReader(f, n, 1<<62)); err != nil {
		return err
	}
	if err := f.Truncate(0); err != nil {
		return err
	}
	_, err = f.WriteAt(kept.Bytes(), 0)
	return err
}

// eachRawLine is eachLine for a rewrite: fn gets every line with its
// newline, and parse is false for one too long to parse (kept verbatim,
// however long).
func eachRawLine(r io.Reader, fn func(line []byte, parse bool)) error {
	br := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			fn(line, len(line) <= maxLineBytes)
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// PurgeDate deletes the day-file for date (already validated via ValidDate)
// under dir. One vector may still be appending to is emptied instead
// (vectorMayHaveOpen), so later lines still land in the file the Logs page
// reads. Deleting an already-missing file is not an error, matching the
// package's general "missing file = no entries" tolerance.
func PurgeDate(dir, date string) error {
	purgeMu.Lock()
	defer purgeMu.Unlock()
	path := filepath.Join(dir, date+".jsonl")
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if vectorMayHaveOpen(info) {
		return os.Truncate(path, 0)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
