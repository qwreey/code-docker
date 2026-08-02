package main

import (
	"net/http"
	"sort"
	"strconv"

	"webmanager/internal/logstore"
)

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

	storeEntries, err := logstore.ReadEntries(s.cfg.VectorLogDir, app, level, limit)
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
		"mock":    false,
	})
}
