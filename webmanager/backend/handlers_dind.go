package main

import (
	"errors"
	"log"
	"net/http"
	"strconv"

	"webmanager/internal/dind"
)

func writeDindErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, dind.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, dind.ErrInvalidID):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}

func (s *Server) handleListDindContainers(w http.ResponseWriter, r *http.Request) {
	containers, err := dind.ListContainers(r.Context())
	if err != nil {
		writeDindErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, containers)
}

func (s *Server) handleListDindImages(w http.ResponseWriter, r *http.Request) {
	images, err := dind.ListImages(r.Context())
	if err != nil {
		writeDindErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, images)
}

const dindDefaultLogTail = 1000

func (s *Server) handleDindContainerLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := dind.ValidateID(id); err != nil {
		writeDindErr(w, err)
		return
	}

	tail := dindDefaultLogTail
	if v := r.URL.Query().Get("tail"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "tail must be a positive integer")
			return
		}
		tail = n
	}

	text, err := dind.ContainerLogs(r.Context(), id, tail, r.URL.Query().Get("since"))
	if err != nil {
		writeDindErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

// M2: start/stop/remove, mutating so gated by RequirePassword in main.go
// (unlike the read-only handlers above). Audit trail is just a log.Printf —
// webmanager's own stdout is already collected by the vector pipeline and
// surfaced in the Logs tab, so no new storage is needed for this (see
// webmanager/.claude/dind-plan.md's "위험 완화" section).
func (s *Server) handleStartDindContainer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := dind.StartContainer(r.Context(), id); err != nil {
		writeDindErr(w, err)
		return
	}
	log.Printf("dind: started container %s", id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleStopDindContainer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := dind.StopContainer(r.Context(), id); err != nil {
		writeDindErr(w, err)
		return
	}
	log.Printf("dind: stopped container %s", id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRemoveDindContainer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// force must be an explicit opt-in query param — never implicit/default
	// force-removal of a running container (plan doc requirement).
	force := r.URL.Query().Get("force") == "true"
	if err := dind.RemoveContainer(r.Context(), id, force); err != nil {
		writeDindErr(w, err)
		return
	}
	log.Printf("dind: removed container %s (force=%v)", id, force)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
