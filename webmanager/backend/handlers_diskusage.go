package main

import "net/http"

func (s *Server) handleDiskBreakdown(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.diskUsage.Snapshot())
}

func (s *Server) handleScanDiskBreakdown(w http.ResponseWriter, r *http.Request) {
	s.diskUsage.TriggerScan()
	writeJSON(w, http.StatusOK, s.diskUsage.Snapshot())
}
