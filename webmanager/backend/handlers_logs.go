package main

import (
	"errors"
	"net/http"
	"sort"
	"strconv"

	"webmanager/internal/logstore"
)

var errInvalidUnixMs = errors.New("value must be a non-negative integer")

// GET /api/logs/apps returns real supervisord process names (unchanged from
// before) and GET /api/logs/entries now reads real vector-produced JSONL
// files instead of generating synthetic data (see internal/logstore and
// webmanager/.claude/vector-logs-plan-done.md for the on-disk contract). Both responses keep
// the "mock" field the frontend keys its "mock data" banner off of, now
// always false.

func (s *Server) handleListLogApps(w http.ResponseWriter, r *http.Request) {
	procs, err := s.sup.GetAllProcessInfo(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	apps := make([]string, 0, len(procs))
	for _, p := range procs {
		apps = append(apps, p.Name)
	}
	sort.Strings(apps)
	writeJSON(w, http.StatusOK, map[string]any{
		"apps": apps,
		"mock": false,
	})
}

type logEntry struct {
	Timestamp int64  `json:"timestamp"`
	App       string `json:"app"`
	Level     string `json:"level"`
	Message   string `json:"message"`
}

func (s *Server) handleListLogEntries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	app := q.Get("app")

	level := q.Get("level")
	if level != "" && level != "info" && level != "warn" && level != "error" {
		writeError(w, http.StatusBadRequest, "level must be info, warn or error")
		return
	}

	limit := 100
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		if n > 1000 {
			n = 1000
		}
		limit = n
	}

	start, err := parseOptionalUnixMs(q.Get("start"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "start must be a non-negative integer")
		return
	}
	end, err := parseOptionalUnixMs(q.Get("end"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "end must be a non-negative integer")
		return
	}
	before, err := parseOptionalUnixMs(q.Get("before"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "before must be a non-negative integer")
		return
	}

	storeEntries, hasMore, err := logstore.ReadEntries(s.cfg.VectorLogDir, app, level, start, end, before, limit)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	entries := make([]logEntry, 0, len(storeEntries))
	for _, e := range storeEntries {
		entries = append(entries, logEntry{
			Timestamp: e.Timestamp,
			App:       e.App,
			Level:     e.Level,
			Message:   e.Message,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"entries": entries,
		"hasMore": hasMore,
		"mock":    false,
	})
}

// parseOptionalUnixMs parses an optional unix-millis query param: "" means
// unset (returns 0, the "unbounded"/"no cursor" sentinel throughout
// logstore.ReadEntries), anything else must be a non-negative integer.
func parseOptionalUnixMs(v string) (int64, error) {
	if v == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		return 0, errInvalidUnixMs
	}
	return n, nil
}

func (s *Server) handleLogRange(w http.ResponseWriter, r *http.Request) {
	earliest, latest, ok := logstore.AvailableRange(s.cfg.VectorLogDir)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{
			"earliest": nil,
			"latest":   nil,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"earliest": earliest.UnixMilli(),
		"latest":   latest.UnixMilli(),
	})
}
