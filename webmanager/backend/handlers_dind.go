package main

import (
	"errors"
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
