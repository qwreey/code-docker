package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"webmanager/internal/gitconfig"
)

func (s *Server) handleGetGitConfig(w http.ResponseWriter, r *http.Request) {
	u, err := gitconfig.GetUser(s.cfg.GitConfigPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) handlePutGitConfig(w http.ResponseWriter, r *http.Request) {
	var body gitconfig.User
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := gitconfig.SetUser(s.cfg.GitConfigPath, body); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) handleListSSHHosts(w http.ResponseWriter, r *http.Request) {
	hosts, err := gitconfig.ListSSHHosts(s.cfg.SSHClientConfig)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, hosts)
}

func (s *Server) handleAddSSHHost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host     string `json:"host"`
		HostName string `json:"hostname"`
		User     string `json:"user"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Host == "" || body.HostName == "" || body.User == "" {
		writeError(w, http.StatusBadRequest, "host, hostname and user are required")
		return
	}

	host, err := gitconfig.AddSSHHost(s.cfg.SSHClientConfig, s.cfg.SSHKeysDir, body.Host, body.HostName, body.User)
	if err != nil {
		switch {
		case errors.Is(err, gitconfig.ErrHostExists):
			writeError(w, http.StatusConflict, err.Error())
		case errors.Is(err, gitconfig.ErrInvalidHost):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusCreated, host)
}

func (s *Server) handleDeleteSSHHost(w http.ResponseWriter, r *http.Request) {
	host := r.PathValue("host")
	if err := gitconfig.DeleteSSHHost(s.cfg.SSHClientConfig, host); err != nil {
		if errors.Is(err, gitconfig.ErrHostNotFound) {
			writeError(w, http.StatusNotFound, "host not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListCredentials(w http.ResponseWriter, r *http.Request) {
	creds, err := gitconfig.ListCredentials(s.cfg.GitCredentialsPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, creds)
}

func (s *Server) handleAddCredential(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host     string `json:"host"`
		Username string `json:"username"`
		Token    string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	cred, err := gitconfig.UpsertCredential(s.cfg.GitCredentialsPath, s.cfg.GitConfigPath, body.Host, body.Username, body.Token)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, cred)
}

func (s *Server) handleDeleteCredential(w http.ResponseWriter, r *http.Request) {
	host := r.PathValue("host")
	if err := gitconfig.DeleteCredential(s.cfg.GitCredentialsPath, host); err != nil {
		if errors.Is(err, gitconfig.ErrCredentialNotFound) {
			writeError(w, http.StatusNotFound, "credential not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
